// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {ArcG2Registry} from "../contracts/ArcG2Registry.sol";

// ─── Minimal ERC-8004 mock ────────────────────────────────────────────────────
contract MockRegistry {
    mapping(uint256 => address) private _owners;
    function setOwner(uint256 id, address who) external { _owners[id] = who; }
    function ownerOf(uint256 id) external view returns (address) { return _owners[id]; }
}

// ─── Rejecting receiver (cannot receive ETH) ──────────────────────────────────
contract Rejecter {
    receive() external payable { revert("nope"); }
}

// ─── Test suite ───────────────────────────────────────────────────────────────
contract ArcG2RegistryTest is Test {

    ArcG2Registry public r;
    MockRegistry  public reg;

    address constant FEE_RECIPIENT  = address(0xFEE1);
    address constant TREASURY_VAULT = address(0xFEE2);
    address constant POSTER         = address(0xA001);
    address constant SOLVER         = address(0xA002);
    address constant OTHER          = address(0xA003);

    uint256 constant BOUNTY         = 1_000 ether;   // 1000 × 10^18 native USDC
    uint48  constant TIMEOUT        = 86_400;        // 24 h

    // Passport IDs
    uint256 constant SOLVER_PASSPORT = 42;
    uint256 constant TARGET_PASSPORT  = 99;

    // Valid packet bytes (minimum 8 bytes: "G2|X|0| " — need at least one payload char)
    bytes constant PKT_H = bytes("G2|H|0| ");
    bytes constant PKT_I = bytes("G2|I|0|hello intel");
    bytes constant PKT_W = bytes("G2|W|0|warning");
    bytes constant PKT_A          = bytes("G2|A|0|done");
    bytes constant PKT_A_VERIFIED = bytes("G2|A|42|done"); // ackPassportId=SOLVER_PASSPORT
    bytes constant PKT_Q = bytes("G2|Q|0|0|open question");  // open query (target=0)

    // Directed query packet: payload = "99|directed question" → targetPassportId=99
    bytes constant PKT_Q_DIR = bytes("G2|Q|0|99|directed question");

    function setUp() public {
        reg = new MockRegistry();
        r   = new ArcG2Registry(address(reg), TIMEOUT, FEE_RECIPIENT, TREASURY_VAULT);
        vm.deal(POSTER,  10_000 ether);
        vm.deal(SOLVER,  1 ether);
        vm.deal(OTHER,   1 ether);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// Post an open query and return queryId.
    function _postOpen() internal returns (bytes32 qid) {
        vm.prank(POSTER);
        vm.recordLogs();
        r.postQuery{value: BOUNTY}(PKT_Q, uint96(BOUNTY));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // G2Signal: topics = [sig, sender, sigType, passportId]; data = (queryId, bounty, verified, payload)
        (qid,,,) = abi.decode(logs[0].data, (bytes32, uint96, bool, bytes));
    }

    /// Post a directed query targeting TARGET_PASSPORT and return queryId.
    function _postDirected() internal returns (bytes32 qid) {
        vm.prank(POSTER);
        vm.recordLogs();
        r.postQuery{value: BOUNTY}(PKT_Q_DIR, uint96(BOUNTY));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (qid,,,) = abi.decode(logs[0].data, (bytes32, uint96, bool, bytes));
    }

    /// Compute expected split values for a given amount.
    function _split(uint256 amount, bool verified)
        internal pure
        returns (uint256 toSolver, uint256 toFee, uint256 toTreasury, uint256 toPoster, uint256 ubiShare)
    {
        toFee     = (amount * 200) / 10_000;
        toTreasury= (amount * 150) / 10_000;
        toPoster  = (amount *  50) / 10_000;
        ubiShare  = (amount * 100) / 10_000;
        if (!verified) { toFee += ubiShare; ubiShare = 0; }
        toSolver  = amount - toFee - toTreasury - toPoster - ubiShare;
    }

    /// Assert balance invariant: contract.balance == totalEscrowed + sum(tracked credits).
    function _assertBalanceInvariant(address solver) internal view {
        uint256 contractBal = address(r).balance;
        uint256 escrowed    = r.totalEscrowed();
        uint256 sumCredits  = r.credits(FEE_RECIPIENT)
                            + r.credits(TREASURY_VAULT)
                            + r.credits(POSTER)
                            + r.credits(solver);
        assertEq(contractBal, escrowed + sumCredits, "balance invariant violated");
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_Constructor_Immutables() public view {
        assertEq(r.feeRecipient(),   FEE_RECIPIENT);
        assertEq(r.treasuryVault(),  TREASURY_VAULT);
        assertEq(r.erc8004Registry(), address(reg));
        assertEq(r.queryTimeout(),   TIMEOUT);
    }

    function test_Constructor_ZeroAddressDefaultsToDeployer() public {
        ArcG2Registry r2 = new ArcG2Registry(address(0), TIMEOUT, address(0), address(0));
        assertEq(r2.feeRecipient(),  address(this));
        assertEq(r2.treasuryVault(), address(this));
    }

    function test_Constructor_ZeroTimeoutReverts() public {
        vm.expectRevert(bytes("timeout=0"));
        new ArcG2Registry(address(0), 0, FEE_RECIPIENT, TREASURY_VAULT);
    }

    // ─── postSignal ───────────────────────────────────────────────────────────

    function test_PostSignal_H() public { vm.prank(POSTER); r.postSignal(PKT_H); }
    function test_PostSignal_I() public { vm.prank(POSTER); r.postSignal(PKT_I); }
    function test_PostSignal_W() public { vm.prank(POSTER); r.postSignal(PKT_W); }
    function test_PostSignal_A() public { vm.prank(POSTER); r.postSignal(PKT_A); }

    function test_PostSignal_Q_Reverts() public {
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.UsePostQueryForQ.selector);
        r.postSignal(PKT_Q);
    }

    function test_PostSignal_TooShort_Reverts() public {
        vm.expectRevert(ArcG2Registry.InvalidPacketFormat.selector);
        r.postSignal(bytes("G2|H|0"));
    }

    function test_PostSignal_BadHeader_Reverts() public {
        vm.expectRevert(ArcG2Registry.InvalidPacketHeader.selector);
        r.postSignal(bytes("XX|H|0| "));
    }

    function test_PostSignal_BadType_Reverts() public {
        vm.expectRevert(ArcG2Registry.InvalidPacketType.selector);
        r.postSignal(bytes("G2|Z|0| "));
    }

    function test_PostSignal_NonDigitPassport_Reverts() public {
        vm.expectRevert(ArcG2Registry.InvalidPassportId.selector);
        r.postSignal(bytes("G2|H|abc|"));
    }

    function test_PostSignal_EmptyPassportId_Reverts() public {
        vm.expectRevert(ArcG2Registry.InvalidPassportId.selector);
        r.postSignal(bytes("G2|H||  "));  // 8 bytes, empty passport field
    }

    function test_PostSignal_Verified_Flag() public {
        reg.setOwner(SOLVER_PASSPORT, POSTER);
        vm.prank(POSTER);
        // checkTopic1=sender, checkTopic2=sigType, checkTopic3=passportId, checkData=false
        vm.expectEmit(true, true, true, false);
        emit ArcG2Registry.G2Signal(POSTER, uint8(0)/*H*/, SOLVER_PASSPORT, bytes32(0), 0, true, bytes(""));
        r.postSignal(bytes("G2|H|42| "));
    }

    function test_PostSignal_Unverified_Flag() public {
        vm.prank(POSTER);
        vm.expectEmit(true, true, true, false);
        emit ArcG2Registry.G2Signal(POSTER, uint8(0)/*H*/, 0, bytes32(0), 0, false, bytes(""));
        r.postSignal(PKT_H);
    }

    // ─── postQuery ────────────────────────────────────────────────────────────

    function test_PostQuery_HappyPath() public {
        bytes32 qid = _postOpen();
        ArcG2Registry.Query memory q = r.getQuery(qid);
        assertEq(q.poster, POSTER);
        assertEq(q.amount, uint96(BOUNTY));
        assertFalse(q.settled);
        assertEq(q.targetPassportId, 0);
    }

    function test_PostQuery_Directed_StoresTarget() public {
        bytes32 qid = _postDirected();
        ArcG2Registry.Query memory q = r.getQuery(qid);
        assertEq(q.targetPassportId, TARGET_PASSPORT);
    }

    function test_PostQuery_IncreasesTotalEscrowed() public {
        _postOpen();
        assertEq(r.totalEscrowed(), BOUNTY);
    }

    function test_PostQuery_ZeroBounty_Reverts() public {
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.ZeroBounty.selector);
        r.postQuery{value: 0}(PKT_Q, 0);
    }

    function test_PostQuery_ValueLessThanBounty_Reverts() public {
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.BountyExceedsValue.selector);
        r.postQuery{value: BOUNTY - 1}(PKT_Q, uint96(BOUNTY));
    }

    function test_PostQuery_NonQType_Reverts() public {
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.MustBeQueryType.selector);
        r.postQuery{value: BOUNTY}(PKT_H, uint96(BOUNTY));
    }

    function test_PostQuery_Tip_AccruesToFeeRecipient() public {
        uint256 tipAmount = 0.1 ether;
        vm.prank(POSTER);
        r.postQuery{value: BOUNTY + tipAmount}(PKT_Q, uint96(BOUNTY));
        assertEq(r.credits(FEE_RECIPIENT), tipAmount);
        assertEq(r.totalEscrowed(), BOUNTY);
    }

    function test_PostQuery_ExactValue_NoTip() public {
        vm.prank(POSTER);
        r.postQuery{value: BOUNTY}(PKT_Q, uint96(BOUNTY));
        assertEq(r.credits(FEE_RECIPIENT), 0);
    }

    function test_PostQuery_QueryIdCollision_Reverts() public {
        vm.startPrank(POSTER);
        r.postQuery{value: BOUNTY}(PKT_Q, uint96(BOUNTY));
        vm.expectRevert(ArcG2Registry.QueryIdCollision.selector);
        r.postQuery{value: BOUNTY}(PKT_Q, uint96(BOUNTY));
        vm.stopPrank();
    }

    // ─── respond — DIRECTED queries ───────────────────────────────────────────

    function test_Respond_Directed_TargetSolverSettles() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();

        uint256 solverBefore = SOLVER.balance;
        vm.prank(SOLVER);
        r.respond(qid, PKT_A);

        ArcG2Registry.Query memory q = r.getQuery(qid);
        assertTrue(q.settled);
        assertEq(r.totalEscrowed(), 0);

        // Unverified split (SOLVER has no passport matching ackPacket passportId=0)
        (uint256 expSolver,,,, ) = _split(BOUNTY, false);
        uint256 ubiUnverified = (BOUNTY * 100) / 10_000;
        // ubiUnverified goes to feeRecipient when unverified; toSolver already includes it in residual calc
        assertEq(SOLVER.balance - solverBefore, expSolver, "unverified solver payout");
    }

    function test_Respond_Directed_TargetSolverVerified_GetsUbi() public {
        // Solver owns ack passport 42
        reg.setOwner(SOLVER_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        reg.setOwner(TARGET_PASSPORT, SOLVER); // SOLVER is also the target

        uint256 solverBefore = SOLVER.balance;
        bytes memory ackWithPassport = bytes("G2|A|42|done");
        vm.prank(SOLVER);
        r.respond(qid, ackWithPassport);

        (uint256 expSolver,,,, uint256 ubi) = _split(BOUNTY, true);
        assertEq(SOLVER.balance - solverBefore, expSolver + ubi, "verified solver push");
    }

    function test_Respond_Directed_NonTarget_Reverts() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();

        vm.prank(OTHER);
        vm.expectRevert(ArcG2Registry.NotTargetSolver.selector);
        r.respond(qid, PKT_A);
    }

    function test_Respond_Directed_UnregisteredTarget_Reverts() public {
        // TARGET_PASSPORT has no owner in registry
        bytes32 qid = _postDirected();
        vm.prank(SOLVER);
        vm.expectRevert(ArcG2Registry.TargetNotRegistered.selector);
        r.respond(qid, PKT_A);
    }

    function test_Respond_Directed_BalanceInvariant_Unverified() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER);
        r.respond(qid, PKT_A);
        _assertBalanceInvariant(SOLVER);
    }

    function test_Respond_Directed_BalanceInvariant_Verified() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        reg.setOwner(SOLVER_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER);
        r.respond(qid, bytes("G2|A|42|done"));
        _assertBalanceInvariant(SOLVER);
    }

    function test_Respond_Directed_SumEqualsAmount() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();

        uint256 solverBefore = SOLVER.balance;
        uint256 feeBefore    = r.credits(FEE_RECIPIENT);
        uint256 treasBefore  = r.credits(TREASURY_VAULT);
        uint256 posterBefore = r.credits(POSTER);

        vm.prank(SOLVER);
        r.respond(qid, PKT_A);

        uint256 solverGot  = SOLVER.balance - solverBefore;
        uint256 feeGot     = r.credits(FEE_RECIPIENT)  - feeBefore;
        uint256 treasGot   = r.credits(TREASURY_VAULT) - treasBefore;
        uint256 posterGot  = r.credits(POSTER)         - posterBefore;

        assertEq(solverGot + feeGot + treasGot + posterGot, BOUNTY, "sum of all payouts must equal bounty");
    }

    function test_Respond_Directed_Reverts_PosterCannotRespond() public {
        reg.setOwner(TARGET_PASSPORT, POSTER);
        bytes32 qid = _postDirected();
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.PosterCannotRespond.selector);
        r.respond(qid, PKT_A);
    }

    function test_Respond_Directed_Reverts_AckTypeMismatch() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER);
        vm.expectRevert(ArcG2Registry.AckTypeMismatch.selector);
        r.respond(qid, PKT_H);
    }

    function test_Respond_Directed_Reverts_QueryExpired() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(SOLVER);
        vm.expectRevert(ArcG2Registry.QueryExpired.selector);
        r.respond(qid, PKT_A);
    }

    function test_Respond_Directed_Reverts_AlreadySettled() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(SOLVER);
        vm.expectRevert(ArcG2Registry.QueryAlreadySettled.selector);
        r.respond(qid, PKT_A);
    }

    function test_Respond_Directed_Reverts_QueryNotFound() public {
        vm.prank(SOLVER);
        vm.expectRevert(ArcG2Registry.QueryNotFound.selector);
        r.respond(bytes32(uint256(99999)), PKT_A);
    }

    // ─── respond — OPEN queries ───────────────────────────────────────────────

    function test_Respond_Open_RecordsAnswer_NoFundsMove() public {
        bytes32 qid = _postOpen();
        uint256 escrowBefore = r.totalEscrowed();
        uint256 contractBal  = address(r).balance;

        vm.prank(SOLVER);
        r.respond(qid, PKT_A);

        // Not settled
        assertFalse(r.getQuery(qid).settled);
        // No funds moved
        assertEq(r.totalEscrowed(), escrowBefore);
        assertEq(address(r).balance, contractBal);
        // Answer recorded
        assertTrue(r.answers(qid, SOLVER).length > 0);
    }

    function test_Respond_Open_TwoSolvers() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(OTHER);  r.respond(qid, bytes("G2|A|0|different answer"));
        assertTrue(r.answers(qid, SOLVER).length > 0);
        assertTrue(r.answers(qid, OTHER).length  > 0);
    }

    function test_Respond_Open_AlreadyAnswered_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(SOLVER);
        vm.expectRevert(ArcG2Registry.AlreadyAnswered.selector);
        r.respond(qid, PKT_A);
    }

    function test_Respond_Open_PosterCannotRespond_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.PosterCannotRespond.selector);
        r.respond(qid, PKT_A);
    }

    // ─── award ────────────────────────────────────────────────────────────────

    function test_Award_Unverified_AccruesToCredits() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);

        uint256 solverCredBefore = r.credits(SOLVER);
        vm.prank(POSTER);
        r.award(qid, SOLVER);

        assertTrue(r.getQuery(qid).settled);
        assertEq(r.totalEscrowed(), 0);

        (uint256 expSolver,,,, ) = _split(BOUNTY, false);
        assertGt(r.credits(SOLVER) - solverCredBefore, 0, "solver got credits");
        assertEq(r.credits(SOLVER) - solverCredBefore, expSolver, "solver credit amount");
    }

    function test_Award_Verified_SolverGetsUbi() public {
        reg.setOwner(SOLVER_PASSPORT, SOLVER);
        bytes32 qid = _postOpen();
        // Respond with ackPassportId=42 so stored passport is SOLVER_PASSPORT
        vm.prank(SOLVER); r.respond(qid, PKT_A_VERIFIED);

        vm.prank(POSTER);
        r.award(qid, SOLVER);

        (uint256 expSolver,,,, uint256 ubi) = _split(BOUNTY, true);
        assertEq(r.credits(SOLVER), expSolver + ubi, "verified solver credit");
    }

    function test_Award_BalanceInvariant_Unverified() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(POSTER); r.award(qid, SOLVER);
        _assertBalanceInvariant(SOLVER);
    }

    function test_Award_BalanceInvariant_Verified() public {
        reg.setOwner(SOLVER_PASSPORT, SOLVER);
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(POSTER); r.award(qid, SOLVER);
        _assertBalanceInvariant(SOLVER);
    }

    function test_Award_SumEqualsAmount() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);

        uint256 solverBefore = r.credits(SOLVER);
        uint256 feeBefore    = r.credits(FEE_RECIPIENT);
        uint256 treasBefore  = r.credits(TREASURY_VAULT);
        uint256 posterBefore = r.credits(POSTER);

        vm.prank(POSTER);
        r.award(qid, SOLVER);

        uint256 solverGot = r.credits(SOLVER)         - solverBefore;
        uint256 feeGot    = r.credits(FEE_RECIPIENT)  - feeBefore;
        uint256 treasGot  = r.credits(TREASURY_VAULT) - treasBefore;
        uint256 posterGot = r.credits(POSTER)         - posterBefore;

        assertEq(solverGot + feeGot + treasGot + posterGot, BOUNTY, "award sum == bounty");
    }

    function test_Award_SolverHasNoAnswer_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.SolverHasNoAnswer.selector);
        r.award(qid, SOLVER);
    }

    function test_Award_NotPoster_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(OTHER);
        vm.expectRevert(ArcG2Registry.NotPoster.selector);
        r.award(qid, SOLVER);
    }

    function test_Award_AlreadySettled_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(POSTER); r.award(qid, SOLVER);
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.QueryAlreadySettled.selector);
        r.award(qid, SOLVER);
    }

    function test_Award_AfterExpiry_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.QueryExpired.selector);
        r.award(qid, SOLVER);
    }

    function test_Award_DirectedQuery_Reverts() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        // Settle it first so we don't get QueryAlreadySettled, but test directed path
        // Actually directed queries can't be awarded. Poster calls award on directed = SolverHasNoAnswer
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.SolverHasNoAnswer.selector);
        r.award(qid, SOLVER);
    }

    // ─── cancelQuery ─────────────────────────────────────────────────────────

    function test_CancelQuery_AfterExpiry_RefundsPoster() public {
        bytes32 qid = _postOpen();
        vm.warp(block.timestamp + TIMEOUT);
        uint256 posterBefore = POSTER.balance;
        vm.prank(POSTER);
        r.cancelQuery(qid);
        assertEq(POSTER.balance - posterBefore, BOUNTY);
        assertTrue(r.getQuery(qid).settled);
        assertEq(r.totalEscrowed(), 0);
    }

    function test_CancelQuery_BalanceInvariant() public {
        bytes32 qid = _postOpen();
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(POSTER); r.cancelQuery(qid);
        _assertBalanceInvariant(SOLVER);
    }

    function test_CancelQuery_BeforeExpiry_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.QueryNotExpired.selector);
        r.cancelQuery(qid);
    }

    function test_CancelQuery_NotPoster_Reverts() public {
        bytes32 qid = _postOpen();
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(OTHER);
        vm.expectRevert(ArcG2Registry.NotPoster.selector);
        r.cancelQuery(qid);
    }

    function test_CancelQuery_AlreadySettled_Reverts() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(POSTER); r.award(qid, SOLVER);
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(POSTER);
        vm.expectRevert(ArcG2Registry.QueryAlreadySettled.selector);
        r.cancelQuery(qid);
    }

    function test_CancelQuery_OpenQueryAfterAnswerButNoAward() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        // Poster ignores the answer and cancels after expiry
        vm.warp(block.timestamp + TIMEOUT);
        uint256 posterBefore = POSTER.balance;
        vm.prank(POSTER); r.cancelQuery(qid);
        assertEq(POSTER.balance - posterBefore, BOUNTY);
    }

    // ─── claim ────────────────────────────────────────────────────────────────

    function test_Claim_FeeRecipient() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER); r.respond(qid, PKT_A);

        uint256 feeCredit = r.credits(FEE_RECIPIENT);
        assertGt(feeCredit, 0);
        uint256 before = FEE_RECIPIENT.balance;
        vm.prank(FEE_RECIPIENT);
        r.claim();
        assertEq(FEE_RECIPIENT.balance - before, feeCredit);
        assertEq(r.credits(FEE_RECIPIENT), 0);
    }

    function test_Claim_Treasury() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER); r.respond(qid, PKT_A);

        uint256 tCred = r.credits(TREASURY_VAULT);
        assertGt(tCred, 0);
        uint256 before = TREASURY_VAULT.balance;
        vm.prank(TREASURY_VAULT);
        r.claim();
        assertEq(TREASURY_VAULT.balance - before, tCred);
    }

    function test_Claim_Poster() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER); r.respond(qid, PKT_A);

        uint256 pCred = r.credits(POSTER);
        assertGt(pCred, 0);
        uint256 before = POSTER.balance;
        vm.prank(POSTER);
        r.claim();
        assertEq(POSTER.balance - before, pCred);
    }

    function test_Claim_Solver_Award() public {
        bytes32 qid = _postOpen();
        vm.prank(SOLVER); r.respond(qid, PKT_A);
        vm.prank(POSTER); r.award(qid, SOLVER);

        uint256 sCred = r.credits(SOLVER);
        assertGt(sCred, 0);
        uint256 before = SOLVER.balance;
        vm.prank(SOLVER);
        r.claim();
        assertEq(SOLVER.balance - before, sCred);
        assertEq(r.credits(SOLVER), 0);
    }

    function test_Claim_Tip_Claimable() public {
        uint256 tipAmount = 0.5 ether;
        vm.prank(POSTER);
        r.postQuery{value: BOUNTY + tipAmount}(PKT_Q, uint96(BOUNTY));
        uint256 before = FEE_RECIPIENT.balance;
        vm.prank(FEE_RECIPIENT);
        r.claim();
        assertEq(FEE_RECIPIENT.balance - before, tipAmount);
    }

    function test_Claim_NothingToClaim_Reverts() public {
        vm.prank(SOLVER);
        vm.expectRevert(ArcG2Registry.NothingToClaim.selector);
        r.claim();
    }

    function test_Claim_CEI_SecondCallReverts() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 qid = _postDirected();
        vm.prank(SOLVER); r.respond(qid, PKT_A);

        vm.prank(FEE_RECIPIENT); r.claim();
        vm.prank(FEE_RECIPIENT);
        vm.expectRevert(ArcG2Registry.NothingToClaim.selector);
        r.claim();
    }

    // ─── previewSplit ─────────────────────────────────────────────────────────

    function test_PreviewSplit_Unverified() public view {
        (uint256 s, uint256 f, uint256 t, uint256 p) = r.previewSplit(BOUNTY, false);
        (uint256 es, uint256 ef, uint256 et, uint256 ep,) = _split(BOUNTY, false);
        assertEq(s, es); assertEq(f, ef); assertEq(t, et); assertEq(p, ep);
        assertEq(s + f + t + p, BOUNTY);
    }

    function test_PreviewSplit_Verified() public view {
        (uint256 s, uint256 f, uint256 t, uint256 p) = r.previewSplit(BOUNTY, true);
        (uint256 es, uint256 ef, uint256 et, uint256 ep, uint256 ubi) = _split(BOUNTY, true);
        assertEq(f, ef); assertEq(t, et); assertEq(p, ep);
        assertEq(s, es, "toSolver excludes ubi");
        // verified: toSolver + ubi == bounty - fees
        assertEq(s + ubi + f + t + p, BOUNTY);
    }

    function test_PreviewSplit_ZeroAmount() public view {
        (uint256 s, uint256 f, uint256 t, uint256 p) = r.previewSplit(0, false);
        assertEq(s + f + t + p, 0);
    }

    // ─── registeredOwner ──────────────────────────────────────────────────────

    function test_RegisteredOwner_ReturnsOwner() public {
        reg.setOwner(1, SOLVER);
        assertEq(r.registeredOwner(1), SOLVER);
    }

    function test_RegisteredOwner_Unknown_ReturnsZero() public view {
        assertEq(r.registeredOwner(9999), address(0));
    }

    function test_RegisteredOwner_DisabledRegistry_ReturnsZero() public {
        ArcG2Registry r2 = new ArcG2Registry(address(0), TIMEOUT, FEE_RECIPIENT, TREASURY_VAULT);
        assertEq(r2.registeredOwner(1), address(0));
    }

    // ─── Multi-query escrow bookkeeping ───────────────────────────────────────

    function test_MultiQuery_TwoSettlements_EscrowZero() public {
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        bytes32 q1 = _postDirected();

        // Different packet to avoid queryId collision (same block, same sender)
        vm.prank(POSTER);
        vm.recordLogs();
        r.postQuery{value: BOUNTY}(bytes("G2|Q|0|99|second directed question"), uint96(BOUNTY));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bytes32 q2,,,) = abi.decode(logs[0].data, (bytes32, uint96, bool, bytes));

        assertEq(r.totalEscrowed(), BOUNTY * 2);
        vm.prank(SOLVER); r.respond(q1, PKT_A);
        assertEq(r.totalEscrowed(), BOUNTY);
        vm.prank(SOLVER); r.respond(q2, PKT_A);
        assertEq(r.totalEscrowed(), 0);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_DirectedRespondSum(uint96 bountyAmt) public {
        vm.assume(bountyAmt > 0 && bountyAmt <= 9999 ether);
        reg.setOwner(TARGET_PASSPORT, SOLVER);
        vm.deal(POSTER, uint256(bountyAmt));
        vm.prank(POSTER);
        vm.recordLogs();
        r.postQuery{value: bountyAmt}(PKT_Q_DIR, bountyAmt);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bytes32 qid,,,) = abi.decode(logs[0].data, (bytes32, uint96, bool, bytes));

        uint256 solverBefore = SOLVER.balance;
        uint256 feeBefore    = r.credits(FEE_RECIPIENT);
        uint256 treasBefore  = r.credits(TREASURY_VAULT);
        uint256 posterBefore = r.credits(POSTER);

        vm.prank(SOLVER); r.respond(qid, PKT_A);

        uint256 total = (SOLVER.balance - solverBefore)
                      + (r.credits(FEE_RECIPIENT)  - feeBefore)
                      + (r.credits(TREASURY_VAULT) - treasBefore)
                      + (r.credits(POSTER)         - posterBefore);
        assertEq(total, bountyAmt, "fuzz sum mismatch");
    }

    function testFuzz_AwardSum(uint96 bountyAmt) public {
        vm.assume(bountyAmt > 0 && bountyAmt <= 9999 ether);
        vm.deal(POSTER, uint256(bountyAmt));
        vm.prank(POSTER);
        vm.recordLogs();
        r.postQuery{value: bountyAmt}(PKT_Q, bountyAmt);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bytes32 qid,,,) = abi.decode(logs[0].data, (bytes32, uint96, bool, bytes));

        vm.prank(SOLVER); r.respond(qid, PKT_A);

        uint256 solverBefore = r.credits(SOLVER);
        uint256 feeBefore    = r.credits(FEE_RECIPIENT);
        uint256 treasBefore  = r.credits(TREASURY_VAULT);
        uint256 posterBefore = r.credits(POSTER);

        vm.prank(POSTER); r.award(qid, SOLVER);

        uint256 total = (r.credits(SOLVER)         - solverBefore)
                      + (r.credits(FEE_RECIPIENT)  - feeBefore)
                      + (r.credits(TREASURY_VAULT) - treasBefore)
                      + (r.credits(POSTER)         - posterBefore);
        assertEq(total, bountyAmt, "award fuzz sum mismatch");
    }
}
