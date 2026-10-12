// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title APEX on Arc — the same APEX, migrated from X1 by burning
/// @notice One supply across two chains. A token only exists here after the same amount was burned on X1
///         (Solana fork, mint Du6Z596D…). The cap equals the X1 total supply at deployment, so the sum of
///         APEX on X1 and APEX on Arc can never exceed what existed before. Only the Migrator can mint.
contract ApexArc {
    string public constant name = "APEX";
    string public constant symbol = "APEX";
    uint8 public constant decimals = 9;                    // same unit as X1
    uint256 public immutable cap;                          // X1 total supply at deployment (raw, 9 dp)
    address public immutable migrator;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 cap_, address migrator_) { require(cap_ > 0 && migrator_ != address(0)); cap = cap_; migrator = migrator_; }

    function mint(address to, uint256 amount) external {
        require(msg.sender == migrator, "only migrator");
        require(to != address(0), "to 0");
        require(totalSupply + amount <= cap, "cap");
        totalSupply += amount; balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _move(f, to, v); return true;
    }
    function _move(address f, address to, uint256 v) internal {
        require(to != address(0), "to 0");
        uint256 b = balanceOf[f]; require(b >= v, "balance");
        balanceOf[f] = b - v; balanceOf[to] += v;
        emit Transfer(f, to, v);
    }
}

/// @title APEX Migrator — mints on Arc against burns on X1
/// @notice The attester (our server) verifies an X1 transaction: a Burn of APEX carrying the memo
///         `APEX|ARC|<arc address>`, then signs a voucher {to, amount, x1Sig}. Anyone may submit the voucher.
///         Each X1 signature mints once. A daily cap bounds the damage of a leaked attester key. Every mint
///         is auditable: the event carries the X1 signature, so anybody can check the burn on X1.
contract ApexMigrator {
    ApexArc public token;
    address public attester;
    uint256 public immutable dailyCap;                     // raw APEX per UTC day
    uint256 public dayIndex; uint256 public mintedToday; uint256 public mintedTotal;
    mapping(bytes32 => bool) public used;                  // keccak of the X1 signature string
    bytes32 private constant TYPEHASH = keccak256("Migrate(address to,uint256 amount,string x1Sig)");
    bytes32 public immutable DOMAIN;

    event Migrated(address indexed to, uint256 amount, string x1Sig);
    event AttesterSet(address indexed attester);

    constructor(address attester_, uint256 dailyCap_) {
        require(attester_ != address(0)); attester = attester_; dailyCap = dailyCap_;
        DOMAIN = keccak256(abi.encode(keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), keccak256("APEX Migrator"), block.chainid, address(this)));
        emit AttesterSet(attester_);
    }
    function setToken(address t) external { require(address(token) == address(0) && msg.sender == attester, "set"); token = ApexArc(t); }
    function setAttester(address a) external { require(msg.sender == attester && a != address(0), "attester"); attester = a; emit AttesterSet(a); }

    function migrate(address to, uint256 amount, string calldata x1Sig, uint8 v, bytes32 r, bytes32 s) external {
        require(address(token) != address(0), "no token");
        bytes32 key = keccak256(bytes(x1Sig));
        require(!used[key], "already migrated");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN, keccak256(abi.encode(TYPEHASH, to, amount, key))));
        require(ecrecover(digest, v, r, s) == attester, "bad voucher");
        uint256 d = block.timestamp / 1 days;
        if (d != dayIndex) { dayIndex = d; mintedToday = 0; }
        require(mintedToday + amount <= dailyCap, "daily cap");
        used[key] = true; mintedToday += amount; mintedTotal += amount;
        token.mint(to, amount);
        emit Migrated(to, amount, x1Sig);
    }
}

/// @title APEX Drip Vault on Arc — releases a fixed share every week to the faucet, forever
/// @notice No owner, no withdraw: the only way out is `release()`, which anyone may call once a week and
///         which sends WEEKLY_BPS of the balance to the faucet contract. Same idea as the immutable
///         perpetual vault on X1, with every release going to claimers.
contract ApexDripVault {
    ApexArc public immutable token;
    address public immutable faucet;
    uint256 public constant WEEK = 7 days;
    uint256 public immutable weeklyBps;
    uint256 public lastRelease;
    uint256 public releasedTotal; uint256 public releases;
    event Released(uint256 amount, uint256 remaining);
    constructor(address token_, address faucet_, uint256 weeklyBps_) {
        require(token_ != address(0) && faucet_ != address(0) && weeklyBps_ > 0 && weeklyBps_ <= 1000, "args");
        token = ApexArc(token_); faucet = faucet_; weeklyBps = weeklyBps_; lastRelease = block.timestamp - WEEK;
    }
    function nextReleaseAt() external view returns (uint256) { return lastRelease + WEEK; }
    function release() external {
        require(block.timestamp >= lastRelease + WEEK, "not yet");
        uint256 bal = token.balanceOf(address(this));
        uint256 amt = bal * weeklyBps / 10000;
        require(amt > 0, "empty");
        lastRelease = block.timestamp; releasedTotal += amt; releases += 1;
        require(token.transfer(faucet, amt), "transfer");
        emit Released(amt, bal - amt);
    }
}

/// @title APEX Faucet on Arc (token side) — pays APEX per claim under on-chain limits
/// @notice Mirrors ApexFaucetArc (the USDC side): operator-paid claims, 8 h cooldown, daily cap, no withdraw.
contract ApexArcFaucet {
    ApexArc public immutable token;
    uint256 public constant COOLDOWN = 8 hours;
    uint256 public constant MAX_CLAIM = 100_000e9;          // ceiling per claim: 100,000 APEX
    address public operator;
    uint256 public claimAmount; uint256 public dailyCap;
    uint256 public dayIndex; uint256 public paidToday; uint256 public paidTotal; uint256 public claimsTotal;
    mapping(address => uint256) public lastClaimAt;
    event Claim(address indexed to, uint256 amount, uint256 potAfter);
    event LimitsSet(uint256 claimAmount, uint256 dailyCap);
    event OperatorSet(address indexed operator);
    modifier onlyOperator() { require(msg.sender == operator, "not operator"); _; }
    constructor(address token_, address op, uint256 amt, uint256 cap) {
        require(token_ != address(0) && op != address(0) && amt > 0 && amt <= MAX_CLAIM && cap >= amt, "args");
        token = ApexArc(token_); operator = op; claimAmount = amt; dailyCap = cap;
        emit OperatorSet(op); emit LimitsSet(amt, cap);
    }
    function setLimits(uint256 amt, uint256 cap) external onlyOperator { require(amt > 0 && amt <= MAX_CLAIM && cap >= amt, "args"); claimAmount = amt; dailyCap = cap; emit LimitsSet(amt, cap); }
    function setOperator(address op) external onlyOperator { require(op != address(0)); operator = op; emit OperatorSet(op); }
    function pay(address to) external onlyOperator {
        require(to != address(0), "to 0");
        uint256 last = lastClaimAt[to];
        require(last == 0 || block.timestamp >= last + COOLDOWN, "cooldown");
        uint256 d = block.timestamp / 1 days;
        if (d != dayIndex) { dayIndex = d; paidToday = 0; }
        uint256 amt = claimAmount;
        require(paidToday + amt <= dailyCap, "daily cap reached");
        require(token.balanceOf(address(this)) >= amt, "pot empty");
        lastClaimAt[to] = block.timestamp; paidToday += amt; paidTotal += amt; claimsTotal += 1;
        require(token.transfer(to, amt), "transfer");
        emit Claim(to, amt, token.balanceOf(address(this)));
    }
    function nextClaimAt(address a) external view returns (uint256) { uint256 l = lastClaimAt[a]; return l == 0 ? 0 : l + COOLDOWN; }
    function status() external view returns (uint256 pot, uint256 claimAmount_, uint256 dailyCap_, uint256 paidToday_, uint256 paidTotal_, uint256 claimsTotal_) {
        uint256 d = block.timestamp / 1 days;
        return (token.balanceOf(address(this)), claimAmount, dailyCap, d == dayIndex ? paidToday : 0, paidTotal, claimsTotal);
    }
}
