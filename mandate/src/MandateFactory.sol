// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MandateBox} from "./MandateBox.sol";

/**
 * @title MandateFactory
 * @notice Creates MandateBoxes. The caller becomes the box's owner. Native USDC sent with create() goes straight into
 * the new box, so creating and funding a box is one transaction with no approval.
 *
 * The factory has no owner, no fee and no switch. Whatever value arrives with create() is passed to the box in the
 * same call, and it refuses plain transfers. (Like any contract it can be force-sent value by a selfdestruct; nothing
 * can take that out, and nothing in the factory reads its own balance.)
 */
contract MandateFactory {
    address public immutable usdc;
    address public immutable implementation;

    uint256 public mandatesCreated;
    /// @notice True for every box this factory created. A seller can check that a payer is a real mandate box.
    mapping(address => bool) public isMandate;

    event MandateCreated(
        address indexed box,
        address indexed owner,
        address indexed agent,
        uint256 maxPerPayment,
        uint256 maxPaymentsPerDay,
        uint256 expiresAt,
        bool anyPayee,
        uint256 fundedWei
    );

    error ZeroAddress();
    error NotAContract();
    error AlreadyExists(address box);

    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0) revert NotAContract();
        usdc = usdc_;
        implementation = address(new MandateBox(usdc_));
    }

    /// @param salt Any value; with the caller's address it fixes the box address (see predict).
    /// @param maxPerPayment USDC base units, 6 decimals (1_000_000 = 1 USDC).
    /// @param expiresAt Unix time at which the agent's spending stops.
    function create(
        bytes32 salt,
        address agent,
        uint128 maxPerPayment,
        uint32 maxPaymentsPerDay,
        uint64 expiresAt,
        bool anyPayee,
        address[] calldata payees
    ) external payable returns (address box) {
        bytes32 s = _salt(msg.sender, salt);
        // A taken address would make CREATE2 fail after burning the caller's gas; refuse it up front instead.
        address predicted = Clones.predictDeterministicAddress(implementation, s);
        if (predicted.code.length != 0) revert AlreadyExists(predicted);
        box = Clones.cloneDeterministic(implementation, s);
        isMandate[box] = true;
        unchecked {
            ++mandatesCreated;
        }
        MandateBox(payable(box)).initialize{value: msg.value}(
            msg.sender, agent, maxPerPayment, maxPaymentsPerDay, expiresAt, anyPayee, payees
        );
        emit MandateCreated(box, msg.sender, agent, maxPerPayment, maxPaymentsPerDay, expiresAt, anyPayee, msg.value);
    }

    /// @notice The address create() will give `owner` for `salt`.
    function predict(address owner, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(owner, salt));
    }

    function _salt(address owner, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
