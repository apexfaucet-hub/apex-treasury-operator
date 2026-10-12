// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Test stand-in for Arc's USDC ERC-20 face. Mirrors FiatToken v2.2 where the box depends on it:
/// EIP-712 domain ("USDC", "2"), EIP-3009 transferWithAuthorization with a bytes signature checked by
/// SignatureChecker (EIP-1271 for contract senders), the same check order, issuer blocks and pause.
/// The real token is exercised against an Arc node in test/arc/run.mjs.
contract MockArcUSDC {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => bool) public isBlacklisted;
    bool public paused;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function setBlacklisted(address a, bool b) external {
        isBlacklisted[a] = b;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        require(!paused, "Pausable: paused");
        require(!isBlacklisted[msg.sender] && !isBlacklisted[from] && !isBlacklisted[to], "Blacklistable: account is blacklisted");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
            )
        );
        require(SignatureChecker.isValidSignatureNow(from, digest, signature), "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(!paused, "Pausable: paused");
        require(!isBlacklisted[from] && !isBlacklisted[to], "Blacklistable: account is blacklisted");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(balanceOf[from] >= value, "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
