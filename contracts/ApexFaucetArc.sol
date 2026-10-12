// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title APEX Faucet on Arc
/// @notice The pot is native USDC (Arc's gas token, 18 decimals). Anyone can fund it.
///         Money leaves ONLY as claims: the operator pays a claimer under limits enforced here,
///         a fixed amount per claim, an 8-hour cooldown per address (three claims a day, the same
///         for everyone), and a daily total. There is no withdraw function: nobody, including the
///         operator, can take the pot back. Limits can only move within the constant ceilings.
contract ApexFaucetArc {
    uint256 public constant MAX_CLAIM = 1e18;      // ceiling per claim: 1 USDC
    uint256 public constant MAX_DAILY = 100e18;    // ceiling per UTC day: 100 USDC
    uint256 public constant COOLDOWN = 8 hours;    // three claims a day

    address public operator;
    uint256 public claimAmount;   // current amount per claim, <= MAX_CLAIM
    uint256 public dailyCap;      // current daily total, <= MAX_DAILY
    uint256 public paidTotal;
    uint256 public claimsTotal;
    uint256 public dayIndex;
    uint256 public paidToday;
    mapping(address => uint256) public lastClaimAt;
    mapping(address => uint256) public claimsOf;

    event Claim(address indexed to, uint256 amount, uint256 potAfter);
    event Funded(address indexed from, uint256 amount);
    event LimitsSet(uint256 claimAmount, uint256 dailyCap);
    event OperatorSet(address indexed operator);

    modifier onlyOperator() { require(msg.sender == operator, "not operator"); _; }

    constructor(address op, uint256 amt, uint256 cap) {
        require(op != address(0), "operator 0");
        require(amt > 0 && amt <= MAX_CLAIM, "claim amount");
        require(cap >= amt && cap <= MAX_DAILY, "daily cap");
        operator = op; claimAmount = amt; dailyCap = cap;
        emit OperatorSet(op); emit LimitsSet(amt, cap);
    }

    receive() external payable { emit Funded(msg.sender, msg.value); }

    function setLimits(uint256 amt, uint256 cap) external onlyOperator {
        require(amt > 0 && amt <= MAX_CLAIM, "claim amount");
        require(cap >= amt && cap <= MAX_DAILY, "daily cap");
        claimAmount = amt; dailyCap = cap;
        emit LimitsSet(amt, cap);
    }

    function setOperator(address op) external onlyOperator {
        require(op != address(0), "operator 0");
        operator = op;
        emit OperatorSet(op);
    }

    /// @notice Pay one claim to `to`. Reverts on cooldown, daily cap or empty pot.
    function pay(address payable to) external onlyOperator {
        require(to != address(0), "to 0");
        uint256 last = lastClaimAt[to];
        require(last == 0 || block.timestamp >= last + COOLDOWN, "cooldown");
        uint256 d = block.timestamp / 1 days;
        if (d != dayIndex) { dayIndex = d; paidToday = 0; }
        uint256 amt = claimAmount;
        require(paidToday + amt <= dailyCap, "daily cap reached");
        require(address(this).balance >= amt, "pot empty");
        lastClaimAt[to] = block.timestamp;
        claimsOf[to] += 1;
        paidToday += amt; paidTotal += amt; claimsTotal += 1;
        (bool ok, ) = to.call{value: amt}("");
        require(ok, "transfer failed");
        emit Claim(to, amt, address(this).balance);
    }

    function pot() external view returns (uint256) { return address(this).balance; }

    function nextClaimAt(address a) external view returns (uint256) {
        uint256 last = lastClaimAt[a];
        return last == 0 ? 0 : last + COOLDOWN;
    }

    function status() external view returns (
        uint256 pot_, uint256 claimAmount_, uint256 dailyCap_, uint256 paidToday_,
        uint256 paidTotal_, uint256 claimsTotal_, uint256 cooldown_, uint256 dayIndex_
    ) {
        uint256 d = block.timestamp / 1 days;
        return (address(this).balance, claimAmount, dailyCap, d == dayIndex ? paidToday : 0, paidTotal, claimsTotal, COOLDOWN, d);
    }
}
