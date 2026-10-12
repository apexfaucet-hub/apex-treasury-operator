// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice The parts of Arc's USDC (0x3600…0000, the ERC-20 face of the native gas token, 6 decimals) this box uses.
interface IArcUSDC {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * @title MandateBox
 * @notice A spending box with rules for one AI agent, owned by one person.
 *
 * The owner puts USDC in and writes the rules: which agent may spend, the most it may pay at once, how many payments
 * it may make per UTC day, which payees it may pay (or any), and until when. The agent then pays on its own, inside
 * those rules. A payment that breaks a rule is refused by this contract. The owner can stop the agent, change the
 * rules or take the money out at any time; nobody else can. There is no admin, no fee and no upgrade. (Circle, as
 * USDC's issuer, can still pause USDC or block an address; that stops agent and owner alike.)
 *
 * Two ways for the agent to pay, both checked against the same rules and the same daily slots:
 *   1. pay(to, value, slot, ref): the agent calls the box, the box sends USDC. Any seller that accepts a plain Arc
 *      USDC transfer can be paid this way.
 *   2. Standard x402 "exact" payments (EIP-3009 transferWithAuthorization, from = this box). Arc's USDC asks this
 *      box (EIP-1271) whether the payment is authorised. The box says yes only when the agent signed exactly that
 *      transfer and the transfer fits the rules. The seller's facilitator must verify the payer with EIP-1271 (not
 *      plain ecrecover) and settle with the bytes-signature overload.
 *
 * Daily limit: every payment uses one of today's numbered slots (0 … maxPaymentsPerDay-1). A slot is a USDC
 * authorization nonce. A slot spent through x402 is recorded by Arc's USDC (authorizationState); a slot spent through
 * pay() is recorded here (usedByPay), and each path checks the other's record, so no slot is used twice. Outside
 * readers should ask slotUsed(), not USDC alone. Today's spend is therefore at most maxPaymentsPerDay × maxPerPayment.
 * Days are UTC days (block.timestamp / 86400): an authorization signed for one day is refused after midnight UTC.
 */
contract MandateBox {
    /// @dev EIP-3009, as used by Arc's USDC (FiatToken v2.2).
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_NO = 0xffffffff;
    /// @notice Upper bound on maxPaymentsPerDay, so the views over today's slots stay bounded (about 6.5M gas at 1000).
    uint256 public constant MAX_PAYMENTS_PER_DAY = 1000;
    /// @notice Sanity ceiling on maxPerPayment: 1,000,000 USDC. Refuses an 18-decimal amount typed by habit
    /// (1 ether as a "1 USDC" cap would allow 10^12 USDC).
    uint256 public constant MAX_PER_PAYMENT = 1_000_000 * 1e6;
    /// @notice Sanity ceiling on expiresAt: ten years from now. Refuses a millisecond timestamp typed by habit.
    uint256 public constant MAX_DURATION = 3650 days;
    string public constant VERSION = "arc-mandate-1";

    /// @notice Why a payment would be refused (0 = it would be accepted). Returned by explain().
    enum Refusal {
        None,
        NoAgent,
        NotAgent,
        Paused,
        Expired,
        ZeroValue,
        OverPerPayment,
        PayeeNotAllowed,
        BadPayee,
        OverDailyCount,
        SlotUsed,
        NotThisTransfer,
        BadAgentSignature,
        Malformed
    }

    IArcUSDC public immutable usdc;
    address public immutable factory;

    address public owner;
    address public agent;
    /// @notice The most one payment may move, in USDC base units (6 decimals: 1_000_000 = 1 USDC).
    uint128 public maxPerPayment;
    /// @notice How many payments the agent may make per UTC day.
    uint32 public maxPaymentsPerDay;
    /// @notice Unix time at which the agent's spending stops. The owner can still withdraw afterwards.
    uint64 public expiresAt;
    bool public paused;
    /// @notice When true the agent may pay any address; otherwise only addresses in isPayee.
    bool public anyPayee;
    bool private _initialized;

    mapping(address => bool) public isPayee;
    /// @notice Slot nonces spent through pay(). Slots spent through x402 are recorded by USDC (authorizationState).
    mapping(bytes32 => bool) public usedByPay;

    event Initialized(address indexed owner);
    event RulesSet(address indexed agent, uint256 maxPerPayment, uint256 maxPaymentsPerDay, uint256 expiresAt, bool anyPayee);
    event PayeeSet(address indexed payee, bool allowed);
    event PausedSet(bool paused);
    event Paid(address indexed to, uint256 value, uint256 indexed day, uint256 slot, bytes32 nonce, bytes32 ref);
    event Withdrawn(address indexed to, uint256 value);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 value);

    error NotOwner();
    error NotFactory();
    error AlreadyInitialized();
    error ZeroAddress();
    error BadAgent();
    error BadPayee();
    error TooManyPaymentsPerDay();
    error PerPaymentTooHigh();
    error ExpiryTooFar();
    error NotInitialized();
    error Refused(Refusal reason);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Deployed once by the factory as the implementation that clones run. The implementation itself can never
    /// be initialised, so it never has an owner or rules, and refuses plain native deposits. (An ERC-20 transfer
    /// through 0x3600 runs no recipient code, so USDC sent to the implementation that way would be stranded: send
    /// money to a box, never to the implementation.)
    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IArcUSDC(usdc_);
        factory = msg.sender;
        _initialized = true;
    }

    /// @notice Native USDC sent straight to the box is a deposit.
    receive() external payable {
        if (owner == address(0)) revert NotInitialized();
    }

    /// @notice Called once by the factory, in the same transaction that creates the box.
    function initialize(
        address owner_,
        address agent_,
        uint128 maxPerPayment_,
        uint32 maxPaymentsPerDay_,
        uint64 expiresAt_,
        bool anyPayee_,
        address[] calldata payees_
    ) external payable {
        if (msg.sender != factory) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        _initialized = true;
        owner = owner_;
        emit Initialized(owner_);
        _setRules(agent_, maxPerPayment_, maxPaymentsPerDay_, expiresAt_, anyPayee_);
        for (uint256 i; i < payees_.length; ++i) _setPayee(payees_[i], true);
    }

    // ---------------------------------------------------------------- agent

    /// @notice The agent pays `value` USDC to `to`, using today's slot number `slot`.
    /// @param ref Free reference for the seller (an order id, a request hash). Only logged.
    function pay(address to, uint256 value, uint256 slot, bytes32 ref) external returns (bytes32 nonce) {
        address a = agent;
        if (a == address(0)) revert Refused(Refusal.NoAgent);
        if (msg.sender != a) revert Refused(Refusal.NotAgent);
        Refusal r;
        (r, nonce) = _rules(to, value, slot);
        if (r != Refusal.None) revert Refused(r);
        if (usdc.authorizationState(address(this), nonce)) revert Refused(Refusal.SlotUsed);
        usedByPay[nonce] = true;
        if (!usdc.transfer(to, value)) revert TransferFailed();
        emit Paid(to, value, today(), slot, nonce, ref);
    }

    /// @notice EIP-1271. Arc's USDC calls this when a transferWithAuthorization names this box as `from`.
    /// @param hash The EIP-712 digest USDC computed for the transfer.
    /// @param signature abi.encode(to, value, validAfter, validBefore, slot, agentSignature), where agentSignature is
    /// the agent's signature over `hash` (an EIP-712 signTypedData of the same transfer).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _explain(hash, signature) == Refusal.None ? ERC1271_MAGIC : ERC1271_NO;
    }

    /// @notice Same check as isValidSignature, but says why a payment would be refused. Input that cannot be decoded
    /// makes it revert (isValidSignature then reverts too, which USDC reads as "no").
    function explain(bytes32 hash, bytes calldata signature) external view returns (Refusal) {
        return _explain(hash, signature);
    }

    // ---------------------------------------------------------------- owner

    function setRules(address agent_, uint128 maxPerPayment_, uint32 maxPaymentsPerDay_, uint64 expiresAt_, bool anyPayee_)
        external
        onlyOwner
    {
        _setRules(agent_, maxPerPayment_, maxPaymentsPerDay_, expiresAt_, anyPayee_);
    }

    function setPayees(address[] calldata allow, address[] calldata disallow) external onlyOwner {
        for (uint256 i; i < allow.length; ++i) _setPayee(allow[i], true);
        for (uint256 i; i < disallow.length; ++i) _setPayee(disallow[i], false);
    }

    /// @notice The stop button. While paused the agent cannot pay; the owner can still withdraw.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice The owner takes money out, at any time, paused or not, expired or not.
    function withdraw(address to, uint256 value) external onlyOwner {
        _withdraw(to, value);
    }

    function withdrawAll(address to) external onlyOwner {
        _withdraw(to, usdc.balanceOf(address(this)));
    }

    /// @notice Any other token sent to the box (EURC, by mistake) can only be taken out by the owner.
    function withdrawToken(address token, address to, uint256 value) external onlyOwner {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IArcUSDC.transfer.selector, to, value));
        if (!ok || (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) || token.code.length == 0) {
            revert TransferFailed();
        }
        emit TokenWithdrawn(token, to, value);
    }

    // ---------------------------------------------------------------- views

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice The USDC authorization nonce that stands for slot `slot` on UTC day `day`.
    function slotNonce(uint256 day, uint256 slot) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), day, slot));
    }

    function slotUsed(uint256 day, uint256 slot) public view returns (bool) {
        bytes32 n = slotNonce(day, slot);
        return usedByPay[n] || usdc.authorizationState(address(this), n);
    }

    /// @notice The first unused slot today, if any.
    function nextFreeSlot() external view returns (bool found, uint256 slot) {
        uint256 d = today();
        uint256 n = maxPaymentsPerDay;
        for (uint256 i; i < n; ++i) {
            if (!slotUsed(d, i)) return (true, i);
        }
        return (false, 0);
    }

    /// @notice Payments the agent can still make today, and the most it can still move today (before the balance).
    function leftToday() external view returns (uint256 payments, uint256 maxValue) {
        uint256 d = today();
        uint256 n = maxPaymentsPerDay;
        for (uint256 i; i < n; ++i) {
            if (!slotUsed(d, i)) ++payments;
        }
        maxValue = payments * maxPerPayment;
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // ---------------------------------------------------------------- internal

    /// @dev The terms an agent wraps around its signature for an x402 payment (see isValidSignature).
    struct Terms {
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        uint256 slot;
        bytes agentSig;
    }

    function _explain(bytes32 hash, bytes calldata signature) internal view returns (Refusal) {
        address a = agent;
        if (a == address(0)) return Refusal.NoAgent;
        // abi.encode(address, uint256 x4, bytes): five words, one offset word, one length word, then the bytes.
        if (signature.length < 32 * 7) return Refusal.Malformed;
        Terms memory t = _decode(signature);
        (Refusal r, bytes32 nonce) = _rules(t.to, t.value, t.slot);
        if (r != Refusal.None) return r;
        if (usdc.authorizationState(address(this), nonce)) return Refusal.SlotUsed;
        // Only a USDC transfer out of this box, with exactly these terms and today's slot nonce, is ever approved.
        // Any other digest (a permit, a cancel, another token, another chain) is refused here.
        if (_transferDigest(t, nonce) != hash) return Refusal.NotThisTransfer;
        if (!_signedByAgent(a, hash, t.agentSig)) return Refusal.BadAgentSignature;
        return Refusal.None;
    }

    /// @dev The agent's own key first (an EOA, or an EOA with EIP-7702 code that has no isValidSignature), then
    /// EIP-1271 for a smart-wallet agent.
    function _signedByAgent(address a, bytes32 hash, bytes memory sig) internal view returns (bool) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        if (err == ECDSA.RecoverError.NoError && rec == a) return true;
        return a.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(a, hash, sig);
    }

    function _decode(bytes calldata signature) internal pure returns (Terms memory t) {
        (t.to, t.value, t.validAfter, t.validBefore, t.slot, t.agentSig) =
            abi.decode(signature, (address, uint256, uint256, uint256, uint256, bytes));
    }

    /// @dev The EIP-712 digest Arc's USDC computes for transferWithAuthorization(from = this box, ...).
    function _transferDigest(Terms memory t, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), t.to, t.value, t.validAfter, t.validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev The rules every payment must meet, whichever way it is made. Returns today's nonce for `slot`.
    function _rules(address to, uint256 value, uint256 slot) internal view returns (Refusal, bytes32 nonce) {
        if (paused) return (Refusal.Paused, 0);
        if (block.timestamp >= expiresAt) return (Refusal.Expired, 0);
        if (value == 0) return (Refusal.ZeroValue, 0);
        if (value > maxPerPayment) return (Refusal.OverPerPayment, 0);
        if (to == address(0) || to == address(this)) return (Refusal.BadPayee, 0);
        if (!anyPayee && !isPayee[to]) return (Refusal.PayeeNotAllowed, 0);
        if (slot >= maxPaymentsPerDay) return (Refusal.OverDailyCount, 0);
        nonce = slotNonce(today(), slot);
        if (usedByPay[nonce]) return (Refusal.SlotUsed, nonce);
        return (Refusal.None, nonce);
    }

    function _setRules(address agent_, uint128 maxPerPayment_, uint32 maxPaymentsPerDay_, uint64 expiresAt_, bool anyPayee_)
        internal
    {
        if (agent_ == address(this)) revert BadAgent();
        if (maxPaymentsPerDay_ > MAX_PAYMENTS_PER_DAY) revert TooManyPaymentsPerDay();
        if (maxPerPayment_ > MAX_PER_PAYMENT) revert PerPaymentTooHigh();
        if (expiresAt_ > block.timestamp + MAX_DURATION) revert ExpiryTooFar();
        agent = agent_;
        maxPerPayment = maxPerPayment_;
        maxPaymentsPerDay = maxPaymentsPerDay_;
        expiresAt = expiresAt_;
        anyPayee = anyPayee_;
        emit RulesSet(agent_, maxPerPayment_, maxPaymentsPerDay_, expiresAt_, anyPayee_);
    }

    function _setPayee(address payee, bool allowed) internal {
        if (payee == address(0) || payee == address(this)) revert BadPayee();
        isPayee[payee] = allowed;
        emit PayeeSet(payee, allowed);
    }

    function _withdraw(address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        if (!usdc.transfer(to, value)) revert TransferFailed();
        emit Withdrawn(to, value);
    }
}
