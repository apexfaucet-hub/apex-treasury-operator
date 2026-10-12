// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MandateBox, IArcUSDC} from "../../src/MandateBox.sol";
import {MandateFactory} from "../../src/MandateFactory.sol";

interface IArcUSDC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @notice Runs the whole mandate story against Arc's real USDC inside one eth_call (state override gives this
/// harness code and a native USDC balance; nothing is broadcast). Arc's USDC moves balances through a native module
/// that local forks cannot run, so this is the test that touches the real token.
/// prepare() and run() start from the same state, so the factory and box land at the same addresses in both.
contract ArcHarness {
    IArcUSDC constant USDC = IArcUSDC(0x3600000000000000000000000000000000000000);
    address constant SHOP = 0x00000000000000000000000000000000005a1e51;
    address constant STRANGER = 0x0000000000000000000000000000000000057a6E;
    bytes32 constant SALT = bytes32("arc-harness");
    uint128 constant CAP = 1_000_000; // 1 USDC
    uint32 constant N = 3;

    struct Prep {
        address factory;
        address box;
        uint256 day;
        bytes32 domainSeparator;
        uint256 timestamp;
        bytes32[3] nonces;
    }

    function prepare() external returns (Prep memory p) {
        MandateFactory f = new MandateFactory(address(USDC));
        p.factory = address(f);
        p.box = f.predict(address(this), SALT);
        p.day = block.timestamp / 1 days;
        p.domainSeparator = USDC.DOMAIN_SEPARATOR();
        p.timestamp = block.timestamp;
        for (uint256 i; i < 3; ++i) p.nonces[i] = keccak256(abi.encode(p.box, p.day, i));
    }

    MandateBox internal box;
    uint256 internal shop0;
    bytes32 internal n1;
    bytes32 internal n2;
    uint256 internal vb;

    /// @param agentEoa the x402 agent's address
    /// @param validBefore validBefore used in every signed authorization
    /// @param sigs [0] agent-signed SHOP 1 USDC slot 1, [1] agent-signed SHOP 2 USDC slot 2 (over the cap),
    ///             [2] another key, SHOP 1 USDC slot 2, [3] agent-signed SHOP 1 USDC slot 2
    function run(address agentEoa, uint256 validBefore, bytes[] calldata sigs) external returns (string memory) {
        vb = validBefore;
        _fund();
        _payPath();
        _x402Path(agentEoa, sigs);
        _withdraw();
        return "ALL OK: fund 5 native + 1 erc20, pay ok, 4 pay refusals, x402 ok, 4 x402 refusals, pause/unpause, withdrawAll 3";
    }

    function _fund() internal {
        MandateFactory f = new MandateFactory(address(USDC));
        address[] memory payees = new address[](1);
        payees[0] = SHOP;
        shop0 = USDC.balanceOf(SHOP);
        // 1. Create and fund in one call with native USDC (18 decimals): 5 USDC.
        box = MandateBox(
            payable(f.create{value: 5 ether}(SALT, address(this), CAP, N, uint64(block.timestamp + 1 days), false, payees))
        );
        require(USDC.balanceOf(address(box)) == 5_000_000, "native funding not visible as 5 USDC");
        require(address(f).balance == 0, "factory kept money");
        // 2. Plain ERC-20 deposit through 0x3600 also lands: +1 USDC.
        require(USDC.transfer(address(box), 1_000_000), "erc20 deposit failed");
        require(USDC.balanceOf(address(box)) == 6_000_000, "erc20 deposit not counted");
    }

    function _payPath() internal {
        // 3. pay() inside the rules.
        box.pay(SHOP, CAP, 0, bytes32("order-1"));
        require(USDC.balanceOf(SHOP) == shop0 + CAP, "pay did not reach shop");
        require(USDC.balanceOf(address(box)) == 5_000_000, "pay moved the wrong amount");
        // 4. pay() refusals, each with its reason.
        _expectRefusal(abi.encodeCall(MandateBox.pay, (SHOP, CAP + 1, 1, 0)), MandateBox.Refusal.OverPerPayment);
        _expectRefusal(abi.encodeCall(MandateBox.pay, (STRANGER, 1, 1, 0)), MandateBox.Refusal.PayeeNotAllowed);
        _expectRefusal(abi.encodeCall(MandateBox.pay, (SHOP, 1, 0, 0)), MandateBox.Refusal.SlotUsed);
        _expectRefusal(abi.encodeCall(MandateBox.pay, (SHOP, 1, N, 0)), MandateBox.Refusal.OverDailyCount);
    }

    function _x402Path(address agentEoa, bytes[] calldata sigs) internal {
        // 5. Hand the box to an x402 agent key. Standard EIP-3009 transfers out of the box, judged by the box (EIP-1271).
        box.setRules(agentEoa, CAP, N, uint64(block.timestamp + 1 days), false);
        n1 = box.slotNonce(box.today(), 1);
        n2 = box.slotNonce(box.today(), 2);
        IArcUSDC3009(address(USDC)).transferWithAuthorization(address(box), SHOP, CAP, 0, vb, n1, sigs[0]);
        require(USDC.balanceOf(SHOP) == shop0 + 2 * CAP, "x402 payment did not reach shop");
        require(box.slotUsed(box.today(), 1), "x402 slot not marked used");
        // 6. x402 refusals: replay, over the cap, wrong signer, redirected.
        _expectFail(_twa(SHOP, CAP, n1, sigs[0]), "replay");
        _expectFail(_twa(SHOP, 2 * CAP, n2, sigs[1]), "over cap");
        _expectFail(_twa(SHOP, CAP, n2, sigs[2]), "stranger");
        _expectFail(_twa(STRANGER, CAP, n2, sigs[3]), "redirect");
        // 7. The stop button stops an already-signed payment; releasing it lets the same payment through.
        box.setPaused(true);
        _expectFail(_twa(SHOP, CAP, n2, sigs[3]), "paused");
        box.setPaused(false);
        IArcUSDC3009(address(USDC)).transferWithAuthorization(address(box), SHOP, CAP, 0, vb, n2, sigs[3]);
        require(USDC.balanceOf(SHOP) == shop0 + 3 * CAP, "x402 after unpause did not reach shop");
        (uint256 left,) = box.leftToday();
        require(left == 0, "slots left after three payments");
    }

    function _withdraw() internal {
        // 8. The owner takes the rest back.
        uint256 me0 = USDC.balanceOf(address(this));
        box.withdrawAll(address(this));
        require(USDC.balanceOf(address(box)) == 0, "box not empty after withdrawAll");
        require(USDC.balanceOf(address(this)) == me0 + 3_000_000, "withdrawAll amount wrong");
        require(USDC.balanceOf(STRANGER) == 0, "stranger received money");
    }

    function _twa(address to, uint256 value, bytes32 nonce, bytes calldata sig) internal view returns (bytes memory) {
        return abi.encodeCall(IArcUSDC3009.transferWithAuthorization, (address(box), to, value, 0, vb, nonce, sig));
    }

    function _expectRefusal(bytes memory data, MandateBox.Refusal r) internal {
        (bool ok, bytes memory ret) = address(box).call(data);
        require(!ok, "pay should have been refused");
        require(keccak256(ret) == keccak256(abi.encodeWithSelector(MandateBox.Refused.selector, r)), "wrong refusal reason");
    }

    function _expectFail(bytes memory data, string memory what) internal {
        (bool ok,) = address(USDC).call(data);
        require(!ok, string.concat("USDC accepted: ", what));
    }

    receive() external payable {}
}
