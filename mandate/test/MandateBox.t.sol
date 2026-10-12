// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MandateBox} from "../src/MandateBox.sol";
import {MandateFactory} from "../src/MandateFactory.sol";
import {MockArcUSDC} from "./MockArcUSDC.sol";

/// @dev A smart-wallet agent: approves a hash when its single signer signed it.
contract SmartAgent {
    address public immutable signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = abi.decode(sig, (uint8, bytes32, bytes32));
        return ecrecover(h, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract MandateBoxTest is Test {
    MockArcUSDC usdc;
    MandateFactory factory;
    MandateBox box;

    address owner = makeAddr("owner");
    address agent;
    uint256 agentPk;
    address shop = makeAddr("shop");
    address stranger = makeAddr("stranger");

    uint128 constant CAP = 1_000_000; // 1 USDC per payment
    uint32 constant N = 5; // 5 payments a day
    uint256 constant T0 = 1_760_000_000;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockArcUSDC();
        factory = new MandateFactory(address(usdc));
        (agent, agentPk) = makeAddrAndKey("agent");
        address[] memory payees = new address[](1);
        payees[0] = shop;
        vm.prank(owner);
        box = MandateBox(payable(factory.create(bytes32(0), agent, CAP, N, uint64(T0 + 30 days), false, payees)));
        usdc.mint(address(box), 10_000_000);
    }

    // ------------------------------------------------------------ helpers

    function _digest(address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(box), to, value, va, vb, nonce))
            )
        );
    }

    struct Auth {
        address to;
        uint256 value;
        uint256 va;
        uint256 vb;
        bytes32 nonce;
        bytes sig;
    }

    /// @dev What an agent's x402 client produces for a payment out of the box.
    function _sign(address to, uint256 value, uint256 slot, uint256 pk) internal view returns (Auth memory a) {
        a.to = to;
        a.value = value;
        a.va = 0;
        a.vb = block.timestamp + 1 hours;
        a.nonce = box.slotNonce(box.today(), slot);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(to, value, a.va, a.vb, a.nonce));
        a.sig = abi.encode(to, value, a.va, a.vb, slot, abi.encodePacked(r, s, v));
    }

    function _settle(Auth memory a) internal {
        usdc.transferWithAuthorization(address(box), a.to, a.value, a.va, a.vb, a.nonce, a.sig);
    }

    function _refused(MandateBox.Refusal r) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MandateBox.Refused.selector, r);
    }

    // ------------------------------------------------------------ pay()

    function test_pay_insideRules() public {
        vm.prank(agent);
        box.pay(shop, CAP, 0, bytes32("order-1"));
        assertEq(usdc.balanceOf(shop), CAP);
        assertEq(usdc.balanceOf(address(box)), 9_000_000);
        assertTrue(box.slotUsed(box.today(), 0));
        (uint256 left, uint256 maxValue) = box.leftToday();
        assertEq(left, N - 1);
        assertEq(maxValue, (N - 1) * CAP);
    }

    function test_pay_refused_overPerPayment() public {
        vm.prank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.OverPerPayment));
        box.pay(shop, CAP + 1, 0, 0);
    }

    function test_pay_refused_zero() public {
        vm.prank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.ZeroValue));
        box.pay(shop, 0, 0, 0);
    }

    function test_pay_refused_unknownPayee() public {
        vm.prank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.PayeeNotAllowed));
        box.pay(stranger, 1, 0, 0);
    }

    function test_pay_refused_selfAndZero() public {
        vm.startPrank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.BadPayee));
        box.pay(address(box), 1, 0, 0);
        vm.expectRevert(_refused(MandateBox.Refusal.BadPayee));
        box.pay(address(0), 1, 0, 0);
        vm.stopPrank();
    }

    function test_pay_refused_dailyCount_and_slotReuse() public {
        vm.startPrank(agent);
        for (uint256 i; i < N; ++i) box.pay(shop, CAP, i, 0);
        vm.expectRevert(_refused(MandateBox.Refusal.OverDailyCount));
        box.pay(shop, 1, N, 0);
        vm.expectRevert(_refused(MandateBox.Refusal.SlotUsed));
        box.pay(shop, 1, 0, 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(shop), N * CAP);
        (uint256 left,) = box.leftToday();
        assertEq(left, 0);
        (bool found,) = box.nextFreeSlot();
        assertFalse(found);
    }

    function test_pay_newDay_newSlots() public {
        vm.startPrank(agent);
        for (uint256 i; i < N; ++i) box.pay(shop, CAP, i, 0);
        vm.warp(block.timestamp + 1 days);
        box.pay(shop, CAP, 0, 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(shop), (N + 1) * CAP);
    }

    function test_pay_refused_expired() public {
        vm.warp(T0 + 30 days);
        vm.prank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.Expired));
        box.pay(shop, 1, 0, 0);
    }

    function test_pay_refused_paused_ownerStillWithdraws() public {
        vm.prank(owner);
        box.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.Paused));
        box.pay(shop, 1, 0, 0);
        vm.prank(owner);
        box.withdraw(owner, 4_000_000);
        assertEq(usdc.balanceOf(owner), 4_000_000);
    }

    function test_pay_refused_notAgent() public {
        vm.prank(stranger);
        vm.expectRevert(_refused(MandateBox.Refusal.NotAgent));
        box.pay(shop, 1, 0, 0);
        vm.prank(owner);
        vm.expectRevert(_refused(MandateBox.Refusal.NotAgent));
        box.pay(shop, 1, 0, 0);
    }

    function test_pay_refused_agentRemoved() public {
        vm.prank(owner);
        box.setRules(address(0), CAP, N, uint64(T0 + 30 days), false);
        vm.prank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.NoAgent));
        box.pay(shop, 1, 0, 0);
    }

    function test_pay_failedTransfer_keepsSlot() public {
        usdc.setBlacklisted(shop, true);
        vm.prank(agent);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        box.pay(shop, 1, 0, 0);
        assertFalse(box.slotUsed(box.today(), 0));
    }

    // ------------------------------------------------------------ x402 path (EIP-3009 + EIP-1271)

    function test_x402_insideRules() public {
        Auth memory a = _sign(shop, CAP, 0, agentPk);
        assertEq(uint8(box.explain(_digest(a.to, a.value, a.va, a.vb, a.nonce), a.sig)), 0);
        _settle(a);
        assertEq(usdc.balanceOf(shop), CAP);
        assertTrue(box.slotUsed(box.today(), 0));
    }

    function test_x402_refused_wrongSigner() public {
        (, uint256 strangerPk) = makeAddrAndKey("stranger-key");
        Auth memory a = _sign(shop, CAP, 0, strangerPk);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
        assertEq(uint8(box.explain(_digest(a.to, a.value, a.va, a.vb, a.nonce), a.sig)), uint8(MandateBox.Refusal.BadAgentSignature));
    }

    function test_x402_refused_overPerPayment() public {
        Auth memory a = _sign(shop, CAP + 1, 0, agentPk);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
    }

    function test_x402_refused_unknownPayee() public {
        Auth memory a = _sign(stranger, 1, 0, agentPk);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
    }

    function test_x402_refused_slotOutOfRange() public {
        Auth memory a = _sign(shop, 1, N, agentPk);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
    }

    /// The wrapper names an allowed payee and a small amount, the transfer itself is different: refused.
    function test_x402_refused_wrapperDoesNotMatchTransfer() public {
        Auth memory a = _sign(shop, CAP, 0, agentPk);
        // Same agent signature and wrapper, but the settled transfer goes to a stranger.
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(box), stranger, a.value, a.va, a.vb, a.nonce, a.sig);
        // Or moves more than the wrapper says.
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(box), shop, a.value + 1, a.va, a.vb, a.nonce, a.sig);
        // Or uses another nonce (a slot from tomorrow, or any free-form nonce).
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(box), shop, a.value, a.va, a.vb, keccak256("free"), a.sig);
    }

    /// The agent signs a wrapper claiming a small amount while signing a big transfer digest: refused.
    function test_x402_refused_liedWrapper() public {
        bytes32 nonce = box.slotNonce(box.today(), 0);
        uint256 vb = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _digest(shop, 5 * CAP, 0, vb, nonce));
        bytes memory sig = abi.encode(shop, uint256(CAP), uint256(0), vb, uint256(0), abi.encodePacked(r, s, v));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(box), shop, 5 * CAP, 0, vb, nonce, sig);
    }

    function test_x402_permitDigestRefused() public view {
        // An EIP-2612 permit digest for this box, signed by the agent: never approved.
        bytes32 permitTypehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(permitTypehash, address(box), shop, type(uint256).max, 0, type(uint256).max))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory raw = abi.encodePacked(r, s, v);
        assertEq(box.isValidSignature(digest, raw), bytes4(0xffffffff));
        bytes memory wrapped = abi.encode(shop, uint256(1), uint256(0), uint256(1), uint256(0), raw);
        assertEq(box.isValidSignature(digest, wrapped), bytes4(0xffffffff));
    }

    function test_x402_malformedNeverApproves() public view {
        bytes32 h = keccak256("x");
        assertEq(box.isValidSignature(h, ""), bytes4(0xffffffff));
        assertEq(box.isValidSignature(h, hex"1234"), bytes4(0xffffffff));
        try box.isValidSignature(h, new bytes(300)) returns (bytes4 m) {
            assertEq(m, bytes4(0xffffffff));
        } catch {}
    }

    function test_x402_andPay_shareSlots() public {
        // Slot 0 spent by x402: pay() cannot reuse it.
        _settle(_sign(shop, CAP, 0, agentPk));
        vm.prank(agent);
        vm.expectRevert(_refused(MandateBox.Refusal.SlotUsed));
        box.pay(shop, 1, 0, 0);
        // Slot 1 spent by pay(): x402 cannot reuse it.
        vm.prank(agent);
        box.pay(shop, CAP, 1, 0);
        Auth memory a = _sign(shop, CAP, 1, agentPk);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
        // The same x402 authorization cannot be settled twice (USDC's own nonce check).
        Auth memory b = _sign(shop, CAP, 2, agentPk);
        _settle(b);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        _settle(b);
        assertEq(usdc.balanceOf(shop), 3 * CAP);
    }

    function test_x402_signedYesterday_refusedToday() public {
        Auth memory a = _sign(shop, CAP, 0, agentPk);
        a.vb = block.timestamp + 3 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _digest(a.to, a.value, a.va, a.vb, a.nonce));
        a.sig = abi.encode(a.to, a.value, a.va, a.vb, uint256(0), abi.encodePacked(r, s, v));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
    }

    /// The owner's stop button works on payments the agent already signed.
    function test_x402_ownerRevokesSignedPayment() public {
        Auth memory a = _sign(shop, CAP, 0, agentPk);
        vm.prank(owner);
        box.setPaused(true);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
        vm.prank(owner);
        box.setPaused(false);
        vm.prank(owner);
        box.setRules(makeAddr("new-agent"), CAP, N, uint64(T0 + 30 days), false);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
        vm.prank(owner);
        box.setRules(agent, CAP, N, uint64(T0 + 30 days), false);
        address[] memory none = new address[](0);
        address[] memory drop = new address[](1);
        drop[0] = shop;
        vm.prank(owner);
        box.setPayees(none, drop);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _settle(a);
    }

    function test_x402_smartWalletAgent() public {
        (address signer, uint256 signerPk) = makeAddrAndKey("smart-signer");
        SmartAgent sa = new SmartAgent(signer);
        vm.prank(owner);
        box.setRules(address(sa), CAP, N, uint64(T0 + 30 days), false);
        bytes32 nonce = box.slotNonce(box.today(), 0);
        uint256 vb = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, _digest(shop, CAP, 0, vb, nonce));
        bytes memory sig = abi.encode(shop, uint256(CAP), uint256(0), vb, uint256(0), abi.encode(v, r, s));
        usdc.transferWithAuthorization(address(box), shop, CAP, 0, vb, nonce, sig);
        assertEq(usdc.balanceOf(shop), CAP);
    }

    /// Review L2: an agent EOA that later carries code without isValidSignature (EIP-7702) keeps the x402 path.
    function test_x402_agentWithCodeButNo1271_stillSignsWithItsKey() public {
        vm.etch(agent, hex"6080604052600080fd"); // code that reverts on every call
        _settle(_sign(shop, CAP, 0, agentPk));
        assertEq(usdc.balanceOf(shop), CAP);
    }

    /// Review L3: unit mistakes are refused instead of silently accepted.
    function test_unitFootgunsRefused() public {
        vm.startPrank(owner);
        vm.expectRevert(MandateBox.PerPaymentTooHigh.selector);
        box.setRules(agent, 1 ether, N, uint64(T0 + 30 days), false);
        vm.expectRevert(MandateBox.ExpiryTooFar.selector);
        box.setRules(agent, CAP, N, uint64(T0 * 1000), false);
        box.setRules(agent, uint128(box.MAX_PER_PAYMENT()), N, uint64(T0 + 3650 days), false);
        vm.stopPrank();
        address[] memory none = new address[](0);
        vm.expectRevert(MandateBox.PerPaymentTooHigh.selector);
        factory.create(bytes32("x"), agent, 1 ether, N, uint64(T0 + 1 days), true, none);
    }

    /// Review L4: the implementation refuses plain native deposits (it has no owner who could take them out).
    function test_implementationRefusesNativeDeposit() public {
        address impl = factory.implementation();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = impl.call{value: 1}("");
        assertFalse(ok);
    }

    function test_anyPayee() public {
        vm.prank(owner);
        box.setRules(agent, CAP, N, uint64(T0 + 30 days), true);
        vm.prank(agent);
        box.pay(stranger, 1, 0, 0);
        _settle(_sign(stranger, 1, 1, agentPk));
        assertEq(usdc.balanceOf(stranger), 2);
    }

    // ------------------------------------------------------------ owner, factory, setup

    function test_onlyOwner() public {
        address[] memory none = new address[](0);
        address[3] memory callers = [agent, stranger, address(factory)];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(MandateBox.NotOwner.selector);
            box.withdraw(callers[i], 1);
            vm.expectRevert(MandateBox.NotOwner.selector);
            box.withdrawAll(callers[i]);
            vm.expectRevert(MandateBox.NotOwner.selector);
            box.setRules(callers[i], type(uint128).max, 1000, type(uint64).max, true);
            vm.expectRevert(MandateBox.NotOwner.selector);
            box.setPayees(none, none);
            vm.expectRevert(MandateBox.NotOwner.selector);
            box.setPaused(false);
            vm.stopPrank();
        }
    }

    function test_withdrawToken_onlyOwner() public {
        MockArcUSDC eurc = new MockArcUSDC();
        eurc.mint(address(box), 7);
        vm.prank(agent);
        vm.expectRevert(MandateBox.NotOwner.selector);
        box.withdrawToken(address(eurc), agent, 7);
        vm.prank(owner);
        box.withdrawToken(address(eurc), owner, 7);
        assertEq(eurc.balanceOf(owner), 7);
        vm.prank(owner);
        vm.expectRevert(MandateBox.TransferFailed.selector);
        box.withdrawToken(makeAddr("no-code"), owner, 1);
    }

    function test_withdrawAll_evenAfterExpiry() public {
        vm.warp(T0 + 365 days);
        vm.prank(owner);
        box.withdrawAll(owner);
        assertEq(usdc.balanceOf(owner), 10_000_000);
        assertEq(usdc.balanceOf(address(box)), 0);
    }

    function test_setup_guards() public {
        vm.startPrank(owner);
        vm.expectRevert(MandateBox.BadAgent.selector);
        box.setRules(address(box), CAP, N, uint64(T0 + 1 days), false);
        vm.expectRevert(MandateBox.TooManyPaymentsPerDay.selector);
        box.setRules(agent, CAP, 1001, uint64(T0 + 1 days), false);
        address[] memory bad = new address[](1);
        address[] memory none = new address[](0);
        vm.expectRevert(MandateBox.BadPayee.selector);
        box.setPayees(bad, none);
        bad[0] = address(box);
        vm.expectRevert(MandateBox.BadPayee.selector);
        box.setPayees(bad, none);
        vm.expectRevert(MandateBox.ZeroAddress.selector);
        box.withdraw(address(0), 1);
        vm.stopPrank();
    }

    function test_initialize_onlyOnce_onlyFactory() public {
        address[] memory none = new address[](0);
        vm.expectRevert(MandateBox.NotFactory.selector);
        box.initialize(stranger, stranger, CAP, N, uint64(T0 + 1 days), true, none);
        vm.prank(address(factory));
        vm.expectRevert(MandateBox.AlreadyInitialized.selector);
        box.initialize(stranger, stranger, CAP, N, uint64(T0 + 1 days), true, none);
        // The implementation can never be initialised, not even by the factory.
        MandateBox impl = MandateBox(payable(factory.implementation()));
        vm.prank(address(factory));
        vm.expectRevert(MandateBox.AlreadyInitialized.selector);
        impl.initialize(stranger, stranger, CAP, N, uint64(T0 + 1 days), true, none);
        assertEq(impl.owner(), address(0));
    }

    function test_factory_predict_value_registry() public {
        address[] memory none = new address[](0);
        address who = makeAddr("creator");
        vm.deal(who, 3 ether);
        address predicted = factory.predict(who, bytes32("s"));
        vm.prank(who);
        address b = factory.create{value: 2 ether}(bytes32("s"), agent, CAP, N, uint64(T0 + 1 days), true, none);
        assertEq(b, predicted);
        assertEq(b.balance, 2 ether);
        assertEq(address(factory).balance, 0);
        assertTrue(factory.isMandate(b));
        assertFalse(factory.isMandate(stranger));
        assertEq(MandateBox(payable(b)).owner(), who);
        assertEq(factory.mandatesCreated(), 2);
        // Same owner and salt again: refused (the address is taken).
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(MandateFactory.AlreadyExists.selector, b));
        factory.create(bytes32("s"), agent, CAP, N, uint64(T0 + 1 days), true, none);
        // The factory refuses plain transfers, so it can never hold money.
        vm.prank(who);
        (bool ok,) = address(factory).call{value: 1}("");
        assertFalse(ok);
        // The box accepts native USDC.
        vm.prank(who);
        (ok,) = b.call{value: 1}("");
        assertTrue(ok);
    }

    // ------------------------------------------------------------ fuzz

    /// Whatever the agent tries in one day, at most N payments of at most CAP reach the shop, nothing reaches others.
    function testFuzz_dailyBound(uint256[12] memory values, uint256[12] memory slots, bool[12] memory toStranger, bool[12] memory viaX402)
        public
    {
        for (uint256 i; i < 12; ++i) {
            uint256 v = bound(values[i], 0, 3 * CAP);
            uint256 s = bound(slots[i], 0, N + 2);
            address to = toStranger[i] ? stranger : shop;
            if (viaX402[i]) {
                Auth memory a = _sign(to, v, s, agentPk);
                try usdc.transferWithAuthorization(address(box), a.to, a.value, a.va, a.vb, a.nonce, a.sig) {} catch {}
            } else {
                vm.prank(agent);
                try box.pay(to, v, s, 0) {} catch {}
            }
        }
        assertLe(usdc.balanceOf(shop), N * CAP);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(shop) + usdc.balanceOf(address(box)), 10_000_000);
    }
}
