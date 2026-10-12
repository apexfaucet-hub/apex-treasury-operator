// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcG2Registry
/// @notice Immutable G2 signal registry with escrowed query bounties and a multi-split fee engine.
/// @dev Immutable after deploy. No owner, no admin, no upgrade path.
///
///      G2 packet format: G2|<Type>|<PassportID>|<Payload>
///      Types: H=Hello  I=Intel  W=Warn  Q=Query  A=Ack
///
///      Query modes:
///      - Directed (targetPassportId != 0): only the named passport owner's address may respond,
///        and respond() settles immediately.
///      - Open (targetPassportId == 0): any non-poster may record an answer in respond();
///        the poster chooses a solver via award() before expiry.
///
///      Native USDC on Arc is the 18-decimal native asset (msg.value).
///
///      Fee split on respond()/award() — applied to the stored bounty amount:
///        95.0% → solver (direct push in directed respond; accrued credit in award)
///         2.0% → feeRecipient     (accrued; pull via claim())
///         1.5% → treasuryVault    (accrued; pull via claim())
///         1.0% → solver if ERC-8004 verified, else feeRecipient (accrued)
///         0.5% → query poster     (accrued; pull via claim())
///      Sub-splits are derived from components so their sum is always exactly the total fee.
///
///      Priority tip: msg.value > bountyAmount in postQuery accrues 100% of excess
///      to feeRecipient's credits (no push, safe even if feeRecipient is a contract).
contract ArcG2Registry is ReentrancyGuard {

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Total protocol fee in basis points (5.00%).
    uint256 public constant PROTOCOL_FEE_BPS = 500;
    uint256 private constant BPS_DENOM = 10_000;

    // ─── Types ───────────────────────────────────────────────────────────────

    enum SigType { H, I, W, Q, A }

    struct Query {
        address poster;            // slot 0: 20 bytes
        uint96  amount;            //         12 bytes  (escrow, excludes tip)
        uint48  expiry;            // slot 1:  6 bytes
        bool    settled;           //          1 byte
        bytes32 packetHash;        // slot 2: 32 bytes
        uint256 targetPassportId;  // slot 3: 32 bytes (0 = open, non-zero = directed)
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @notice Open and settled queries keyed by queryId.
    mapping(bytes32 => Query)   public queries;

    /// @notice Recorded answers for open queries keyed by queryId and solver.
    mapping(bytes32 => mapping(address => bytes)) public answers;

    /// @notice Recorded ack passport IDs keyed by queryId and solver.
    mapping(bytes32 => mapping(address => uint256)) public answerPassport;

    /// @notice Accrued credits withdrawable via claim(). Covers fee shares, tip, poster bonus.
    mapping(address => uint256) public credits;

    /// @notice Total native USDC currently held in escrow for open queries.
    uint256 public totalEscrowed;

    /// @notice Query expiry timeout in seconds (immutable).
    uint48  public immutable queryTimeout;

    /// @notice ERC-8004 identity registry for passport verification. address(0) disables.
    address public immutable erc8004Registry;

    /// @notice Recipient of the 2% base fee + unverified UBI + priority tip credits.
    address public immutable feeRecipient;

    /// @notice Protocol treasury vault receiving the 1.5% network incentive credits.
    address public immutable treasuryVault;

    // ─── Errors ──────────────────────────────────────────────────────────────

    error InvalidPacketHeader();
    error InvalidPacketType();
    error InvalidPacketFormat();
    error InvalidPassportId();
    error UsePostQueryForQ();
    error MustBeQueryType();
    error ZeroBounty();
    error BountyExceedsValue();
    error QueryIdCollision();
    error QueryNotFound();
    error QueryAlreadySettled();
    error QueryExpired();
    error QueryNotExpired();
    error PosterCannotRespond();
    error NotPoster();
    error TransferFailed();
    error AckTypeMismatch();
    error NothingToClaim();
    error TargetNotRegistered();
    error NotTargetSolver();
    error AlreadyAnswered();
    error SolverHasNoAnswer();

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted for every G2 packet posted or acked.
    event G2Signal(
        address indexed sender,
        uint8   indexed sigType,
        uint256 indexed passportId,
        bytes32         queryId,
        uint96          bounty,
        bool            verified,
        bytes           payload
    );

    /// @notice Emitted when a query is settled in respond() or award().
    /// @param toSolver       Amount paid to the solver (pushed in respond, accrued in award).
    /// @param totalFee       Total protocol fee taken (feeRecipient + treasuryVault + poster).
    /// @param tipAccrued     Priority tip that accrued to feeRecipient (0 on settlement paths).
    event QuerySettled(
        bytes32 indexed queryId,
        address indexed solver,
        uint256 toSolver,
        uint256 totalFee,
        uint256 tipAccrued
    );

    /// @notice Emitted when a recipient pulls their accrued credits.
    event Claimed(address indexed recipient, uint256 amount);

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @notice Deploy the Arc G2 registry.
    /// @param _erc8004Registry ERC-8004 registry for ownerOf() checks. address(0) disables.
    /// @param _queryTimeout    Query expiry window in seconds (must be > 0).
    /// @param _feeRecipient    Base fee + tip recipient. Defaults to deployer if address(0).
    /// @param _treasuryVault   Treasury share recipient. Defaults to deployer if address(0).
    constructor(
        address _erc8004Registry,
        uint48  _queryTimeout,
        address _feeRecipient,
        address _treasuryVault
    ) {
        require(_queryTimeout > 0, "timeout=0");
        erc8004Registry = _erc8004Registry;
        queryTimeout    = _queryTimeout;
        feeRecipient    = _feeRecipient  == address(0) ? msg.sender : _feeRecipient;
        treasuryVault   = _treasuryVault == address(0) ? msg.sender : _treasuryVault;
    }

    // ─── Internal: packet parser ──────────────────────────────────────────────

    /// @notice Parse a G2 pipe-delimited packet.
    /// @param packet Raw G2 packet bytes.
    /// @return sigType    Parsed signal type.
    /// @return passportId Decimal passport ID (0 = anonymous).
    /// @return payload    Payload bytes after the second pipe delimiter.
    function _parsePacket(bytes calldata packet)
        internal
        pure
        returns (SigType sigType, uint256 passportId, bytes memory payload)
    {
        uint256 len = packet.length;
        if (len < 8) revert InvalidPacketFormat();

        if (packet[0] != 0x47 || packet[1] != 0x32 || packet[2] != 0x7c) {
            revert InvalidPacketHeader();
        }

        uint8 t = uint8(packet[3]);
        if      (t == 72) sigType = SigType.H;
        else if (t == 73) sigType = SigType.I;
        else if (t == 87) sigType = SigType.W;
        else if (t == 81) sigType = SigType.Q;
        else if (t == 65) sigType = SigType.A;
        else revert InvalidPacketType();

        if (packet[4] != 0x7c) revert InvalidPacketFormat();

        uint256 i = 5;
        for (;; ++i) {
            if (i >= len) revert InvalidPacketFormat();
            if (i > 83)   revert InvalidPacketFormat();

            uint8 c = uint8(packet[i]);
            if (c == 124) {
                if (i == 5) revert InvalidPassportId();
                payload = packet[i + 1:];
                return (sigType, passportId, payload);
            }
            if (c < 48 || c > 57) revert InvalidPassportId();

            uint256 digit = c - 48;
            if (passportId > type(uint256).max / 10)        revert InvalidPassportId();
            passportId *= 10;
            if (passportId > type(uint256).max - digit)     revert InvalidPassportId();
            passportId += digit;
        }
    }

    // ─── Internal: passport check ─────────────────────────────────────────────

    /// @notice Returns true when msg.sender owns passportId in the ERC-8004 registry.
    function _checkPassport(uint256 passportId) internal view returns (bool) {
        if (erc8004Registry == address(0) || passportId == 0) return false;
        bytes memory cd = abi.encodeWithSelector(bytes4(keccak256("ownerOf(uint256)")), passportId);
        (bool ok, bytes memory res) = erc8004Registry.staticcall(cd);
        if (!ok || res.length < 32) return false;
        return abi.decode(res, (address)) == msg.sender;
    }

    /// @notice Returns true when `who` owns passportId in the ERC-8004 registry.
    function _checkPassportFor(address who, uint256 passportId) internal view returns (bool) {
        if (erc8004Registry == address(0) || passportId == 0) return false;
        bytes memory cd = abi.encodeWithSelector(bytes4(keccak256("ownerOf(uint256)")), passportId);
        (bool ok, bytes memory res) = erc8004Registry.staticcall(cd);
        if (!ok || res.length < 32) return false;
        return abi.decode(res, (address)) == who;
    }

    // ─── External: postSignal ─────────────────────────────────────────────────

    /// @notice Post a G2 memo signal (H, I, W, or A). No value accepted.
    /// @param packet G2 pipe-delimited packet bytes.
    function postSignal(bytes calldata packet) external {
        (SigType sigType, uint256 passportId, bytes memory payload) = _parsePacket(packet);
        if (sigType == SigType.Q) revert UsePostQueryForQ();
        bool verified = _checkPassport(passportId);
        emit G2Signal(msg.sender, uint8(sigType), passportId, bytes32(0), 0, verified, payload);
    }

    // ─── External: postQuery ──────────────────────────────────────────────────

    /// @notice Post a G2|Q query signal with a native USDC bounty in escrow.
    /// @dev    msg.value must be >= bountyAmount. Excess is accrued to feeRecipient as
    ///         a priority tip (pull model — no push on query creation).
    /// @param packet       Must be type Q. Payload must start with a decimal target passport ID followed by '|'. Use 0 for an open query.
    /// @param bountyAmount The portion of msg.value held as the task bounty (uint96 max).
    function postQuery(bytes calldata packet, uint96 bountyAmount) external payable {
        (SigType sigType, uint256 passportId, bytes memory payload) = _parsePacket(packet);
        if (sigType != SigType.Q)     revert MustBeQueryType();
        if (bountyAmount == 0)        revert ZeroBounty();
        if (msg.value < bountyAmount) revert BountyExceedsValue();

        if (payload.length == 0) revert InvalidPacketFormat();

        uint256 sep = type(uint256).max;
        for (uint256 i = 0; i < payload.length; ++i) {
            if (payload[i] == 0x7c) {
                sep = i;
                break;
            }
        }
        if (sep == type(uint256).max) revert InvalidPacketFormat();
        if (sep == 0) revert InvalidPassportId();

        uint256 targetPassportId = 0;
        for (uint256 j = 0; j < sep; ++j) {
            uint8 c = uint8(payload[j]);
            if (c < 48 || c > 57) revert InvalidPassportId();
            uint256 digit = c - 48;
            if (targetPassportId > type(uint256).max / 10) revert InvalidPassportId();
            targetPassportId *= 10;
            if (targetPassportId > type(uint256).max - digit) revert InvalidPassportId();
            targetPassportId += digit;
        }

        uint256 remaining = payload.length - (sep + 1);
        bytes memory freePayload = new bytes(remaining);
        for (uint256 k = 0; k < remaining; ++k) {
            freePayload[k] = payload[sep + 1 + k];
        }

        bytes32 packetHash = keccak256(packet);
        bytes32 queryId    = keccak256(abi.encode(msg.sender, packetHash, block.number));
        if (queries[queryId].poster != address(0)) revert QueryIdCollision();

        queries[queryId] = Query({
            poster:           msg.sender,
            amount:           bountyAmount,
            expiry:           uint48(block.timestamp) + queryTimeout,
            settled:          false,
            packetHash:       packetHash,
            targetPassportId: targetPassportId
        });
        totalEscrowed += bountyAmount;

        // Accrue priority tip — pull model, never a push
        uint256 tip = msg.value - bountyAmount;
        if (tip > 0) credits[feeRecipient] += tip;

        bool verified = _checkPassport(passportId);
        emit G2Signal(msg.sender, uint8(SigType.Q), passportId, queryId, bountyAmount, verified, freePayload);
    }

    // ─── External: respond ────────────────────────────────────────────────────

    /// @notice Respond to a G2|Q query with a G2|A ack.
    /// @dev    Directed queries settle immediately. Open queries only record answers.
    /// @param queryId   The query ID to respond to.
    /// @param ackPacket Must be a valid G2|A packet.
    function respond(bytes32 queryId, bytes calldata ackPacket) external nonReentrant {
        Query storage q = queries[queryId];

        if (q.poster == address(0)) revert QueryNotFound();
        if (q.settled)              revert QueryAlreadySettled();
        if (block.timestamp >= q.expiry) revert QueryExpired();
        if (msg.sender == q.poster) revert PosterCannotRespond();

        if (q.targetPassportId != 0) {
            address targetOwner = this.registeredOwner(q.targetPassportId);
            if (targetOwner == address(0)) revert TargetNotRegistered();
            if (msg.sender != targetOwner) revert NotTargetSolver();
        } else {
            if (answers[queryId][msg.sender].length > 0) revert AlreadyAnswered();
        }

        (SigType ackType, uint256 ackPassportId, bytes memory ackPayload) = _parsePacket(ackPacket);
        if (ackType != SigType.A) revert AckTypeMismatch();

        answerPassport[queryId][msg.sender] = ackPassportId;

        bool verified = _checkPassport(ackPassportId);
        emit G2Signal(msg.sender, uint8(SigType.A), ackPassportId, queryId, 0, verified, ackPayload);

        if (q.targetPassportId == 0) {
            answers[queryId][msg.sender] = ackPayload;
            return;
        }

        uint256 amount = q.amount;
        address poster = q.poster;

        // ── CEI: state updated before any value movement ──
        q.settled = true;
        totalEscrowed -= amount;

        // ── Fee split arithmetic ──
        // Each leg derived from `amount` independently; toSolver absorbs any rounding
        // so sum(all legs) == amount exactly.
        uint256 toFeeRecipient = (amount * 200) / BPS_DENOM;  // 2.0%
        uint256 toTreasury     = (amount * 150) / BPS_DENOM;  // 1.5%
        uint256 toPoster       = (amount *  50) / BPS_DENOM;  // 0.5%

        // 1% UBI: goes to solver (on top) if verified, else accrues to feeRecipient
        uint256 ubiShare = (amount * 100) / BPS_DENOM;        // 1.0%
        if (!verified) {
            toFeeRecipient += ubiShare;
            ubiShare = 0;
        }

        // Solver receives remainder; verified UBI is paid in addition below
        uint256 toSolver = amount - toFeeRecipient - toTreasury - toPoster - ubiShare;

        uint256 totalFee = toFeeRecipient + toTreasury + toPoster;

        // ── Accrue side recipients (pull) ──
        credits[feeRecipient] += toFeeRecipient;
        credits[treasuryVault] += toTreasury;
        credits[poster]        += toPoster;

        emit QuerySettled(queryId, msg.sender, toSolver + ubiShare, totalFee, 0);

        // ── Push to solver only (caller = cannot revert on themselves) ──
        (bool ok,) = payable(msg.sender).call{value: toSolver + ubiShare}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Award an open query to a solver who has recorded an answer.
    /// @dev    Solver passport is taken from the stored ackPassportId recorded in respond().
    /// @param queryId The query ID to settle.
    /// @param solver  The chosen solver address.
    function award(bytes32 queryId, address solver) external nonReentrant {
        Query storage q = queries[queryId];

        if (q.poster == address(0)) revert QueryNotFound();
        if (q.settled)              revert QueryAlreadySettled();
        if (block.timestamp >= q.expiry) revert QueryExpired();
        if (msg.sender != q.poster) revert NotPoster();
        if (q.targetPassportId != 0) revert SolverHasNoAnswer();
        if (answers[queryId][solver].length == 0) revert SolverHasNoAnswer();

        uint256 amount = q.amount;
        address poster = q.poster;

        // ── CEI: state updated before any value movement ──
        q.settled = true;
        totalEscrowed -= amount;

        // ── Fee split arithmetic ──
        uint256 toFeeRecipient = (amount * 200) / BPS_DENOM;  // 2.0%
        uint256 toTreasury     = (amount * 150) / BPS_DENOM;  // 1.5%
        uint256 toPoster       = (amount *  50) / BPS_DENOM;  // 0.5%

        uint256 storedPassport = answerPassport[queryId][solver];
        bool verified = _checkPassportFor(solver, storedPassport);

        // 1% UBI: goes to solver (on top) if verified, else accrues to feeRecipient
        uint256 ubiShare = (amount * 100) / BPS_DENOM;        // 1.0%
        if (!verified) {
            toFeeRecipient += ubiShare;
            ubiShare = 0;
        }

        // Solver receives remainder; verified UBI is accrued to solver below
        uint256 toSolver = amount - toFeeRecipient - toTreasury - toPoster - ubiShare;

        uint256 totalFee = toFeeRecipient + toTreasury + toPoster;

        // ── Accrue recipients (pull) ──
        credits[feeRecipient] += toFeeRecipient;
        credits[treasuryVault] += toTreasury;
        credits[poster]        += toPoster;
        credits[solver]        += toSolver + ubiShare;

        emit G2Signal(solver, uint8(SigType.A), storedPassport, queryId, 0, verified, answers[queryId][solver]);
        emit QuerySettled(queryId, solver, toSolver + ubiShare, totalFee, 0);
    }

    // ─── External: cancelQuery ────────────────────────────────────────────────

    /// @notice Cancel an expired, unsettled query and reclaim the full bounty.
    /// @dev    Push to poster is safe here: poster is msg.sender (the caller cannot
    ///         DoS themselves). No side-recipient payments on cancellation.
    /// @param queryId The query ID to cancel.
    function cancelQuery(bytes32 queryId) external nonReentrant {
        Query storage q = queries[queryId];

        if (q.poster == address(0)) revert QueryNotFound();
        if (q.settled)              revert QueryAlreadySettled();
        if (msg.sender != q.poster) revert NotPoster();
        if (block.timestamp < q.expiry) revert QueryNotExpired();

        uint256 amount = q.amount;

        q.settled = true;
        totalEscrowed -= amount;

        emit G2Signal(msg.sender, uint8(SigType.W), 0, queryId, 0, false, bytes("cancelled"));

        // Safe: msg.sender == poster; caller cannot DoS themselves
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ─── External: claim ──────────────────────────────────────────────────────

    /// @notice Withdraw all accrued fee credits for msg.sender.
    /// @dev    Covers feeRecipient, treasuryVault, and poster bonus credits.
    function claim() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToClaim();
        credits[msg.sender] = 0;
        emit Claimed(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Get a stored query by ID.
    function getQuery(bytes32 queryId) external view returns (Query memory) {
        return queries[queryId];
    }

    /// @notice Look up the registered owner of a passport in the ERC-8004 registry.
    /// @param passportId Passport token ID.
    /// @return owner Registered owner, or address(0) on failure / disabled registry.
    function registeredOwner(uint256 passportId) external view returns (address owner) {
        if (erc8004Registry == address(0)) return address(0);
        bytes memory cd = abi.encodeWithSelector(bytes4(keccak256("ownerOf(uint256)")), passportId);
        (bool ok, bytes memory res) = erc8004Registry.staticcall(cd);
        if (!ok || res.length < 32) return address(0);
        owner = abi.decode(res, (address));
    }

    /// @notice Preview the payout split for a given bounty.
    /// @param bountyAmount   Hypothetical bounty in native USDC (18 dec).
    /// @param solverVerified Whether the solver would pass the ERC-8004 check.
    /// @return toSolver       Amount the solver would receive.
    /// @return toFeeRecipient Amount accrued to feeRecipient.
    /// @return toTreasury     Amount accrued to treasuryVault.
    /// @return toPoster       Amount accrued to the query poster.
    function previewSplit(uint256 bountyAmount, bool solverVerified)
        external
        pure
        returns (
            uint256 toSolver,
            uint256 toFeeRecipient,
            uint256 toTreasury,
            uint256 toPoster
        )
    {
        toFeeRecipient   = (bountyAmount * 200) / BPS_DENOM;
        toTreasury       = (bountyAmount * 150) / BPS_DENOM;
        toPoster         = (bountyAmount *  50) / BPS_DENOM;
        uint256 ubiShare = (bountyAmount * 100) / BPS_DENOM;
        if (!solverVerified) {
            toFeeRecipient += ubiShare;
            ubiShare = 0;
        }
        toSolver = bountyAmount - toFeeRecipient - toTreasury - toPoster - ubiShare;
    }
}
