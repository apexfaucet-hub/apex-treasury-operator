// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ApexPublicGood
/// @dev Every donation is forwarded in the same transaction to the APEX faucet on Arc (USDC) or its drip vault (APEX). This contract holds nothing. Soulbound receipt NFTs are minted to donors as permanent proof of contribution.
contract ApexPublicGood is ERC721, ReentrancyGuard {
    address public constant APEX_TOKEN = 0x59933F316417C89d9dC5107B30f08C99b774Ea9D;
    address public constant FAUCET = 0x53FB2e89834050aFaa9b3090A1Fc9d1064615805;
    address public constant DRIP_VAULT = 0x2d644A0aa8e821B31707228F23C387c84134049a;
    uint256 public constant MAX_MSG_LEN = 100;
    uint256 public constant RING_ACTIVITY = 20;
    uint256 public constant RING_FUNDERS = 50;

    uint256 public totalNativeUsdcForwarded;
    uint256 public totalApexForwarded;
    uint256 public funderCount;
    mapping(address => bool) public hasFunded;

    struct Activity {
        address funder;
        address token;
        uint256 amount;
        string message;
        uint256 timestamp;
    }

    Activity[RING_ACTIVITY] private recentActivity;
    uint256 private activityIndex;

    address[RING_FUNDERS] private recentFunders;
    uint256 private recentFunderIndex;

    uint256 private _nextTokenId = 1;

    mapping(uint256 => address) public tokenFunder;
    mapping(uint256 => uint256) public tokenAmount;
    mapping(uint256 => address) public tokenToken;
    mapping(uint256 => uint8) public tokenDecimals;

    error ZeroAmount();
    error ForwardFailed();
    error OnlyApexToken();
    error Soulbound();

    event Funded(address indexed funder, address indexed token, uint256 amount, string message);

    /// @notice Initializes the soulbound receipt NFT collection.
    constructor() ERC721("Fueled Free APEX", "FREEAPEX") {}

    /// @notice Forward native USDC donation (msg.value) to the Arc faucet and mint a soulbound receipt.
    /// @param message Optional donor note, truncated to at most 100 bytes.
    function fund(string calldata message) external payable {
        if (msg.value == 0) revert ZeroAmount();

        string memory msg_ = _truncate(message);
        _recordActivity(msg.sender, address(0), msg.value, msg_);
        _recordUniqueFunder(msg.sender);
        totalNativeUsdcForwarded += msg.value;

        uint8 dec = 18;
        _mintReceipt(msg.sender, msg.value, address(0), dec);

        emit Funded(msg.sender, address(0), msg.value, msg_);

        (bool ok,) = FAUCET.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
    }

    /// @notice Forward APEX donation directly to the drip vault and mint a soulbound receipt.
    /// @param token Token address to fund with (must be the APEX token).
    /// @param amount Token amount to transfer.
    /// @param message Optional donor note, truncated to at most 100 bytes.
    function fundToken(address token, uint256 amount, string calldata message) external nonReentrant {
        if (token != APEX_TOKEN) revert OnlyApexToken();
        if (amount == 0) revert ZeroAmount();

        string memory msg_ = _truncate(message);

        uint256 beforeBal = IERC20Metadata(APEX_TOKEN).balanceOf(DRIP_VAULT);
        SafeERC20.safeTransferFrom(IERC20Metadata(APEX_TOKEN), msg.sender, DRIP_VAULT, amount);
        uint256 received = IERC20Metadata(APEX_TOKEN).balanceOf(DRIP_VAULT) - beforeBal;

        if (received == 0) revert ZeroAmount();

        uint8 dec = IERC20Metadata(APEX_TOKEN).decimals();

        _recordActivity(msg.sender, APEX_TOKEN, received, msg_);
        _recordUniqueFunder(msg.sender);
        totalApexForwarded += received;
        _mintReceipt(msg.sender, received, APEX_TOKEN, dec);

        emit Funded(msg.sender, APEX_TOKEN, received, msg_);
    }

    /// @notice Returns current contract balances of native USDC and APEX.
    function contractBalance() external view returns (uint256 native, uint256 apex) {
        native = address(this).balance;
        apex = IERC20Metadata(APEX_TOKEN).balanceOf(address(this));
    }

    /// @notice Returns aggregate forwarding stats and receipt count.
    function stats() external view returns (uint256 nativeForwarded, uint256 apexForwarded, uint256 funders, uint256 nftsMinted) {
        nativeForwarded = totalNativeUsdcForwarded;
        apexForwarded = totalApexForwarded;
        funders = funderCount;
        nftsMinted = _nextTokenId - 1;
    }

    /// @notice Returns total forwarded native USDC and forwarded APEX.
    function totalFunded() external view returns (uint256 native, uint256 apex) {
        native = totalNativeUsdcForwarded;
        apex = totalApexForwarded;
    }

    /// @notice Returns all 20 activity ring slots in insertion order (oldest first).
    function getRecentActivity() external view returns (Activity[] memory ordered) {
        ordered = new Activity[](RING_ACTIVITY);
        for (uint256 i = 0; i < RING_ACTIVITY; i++) {
            ordered[i] = recentActivity[(activityIndex + i) % RING_ACTIVITY];
        }
    }

    /// @notice Returns a raw activity slot by ring-buffer index.
    /// @param index Slot index in [0..19].
    function getActivity(uint256 index) external view returns (Activity memory) {
        return recentActivity[index];
    }

    /// @notice Returns a raw unique-funder slot by ring-buffer index.
    /// @param index Slot index in [0..49].
    function getRecentFunderAt(uint256 index) external view returns (address) {
        return recentFunders[index];
    }

    /// @notice Returns fully on-chain metadata + SVG for a soulbound receipt token.
    /// @param tokenId Receipt NFT id.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        address funder = tokenFunder[tokenId];
        uint256 amount = tokenAmount[tokenId];
        address token = tokenToken[tokenId];
        string memory amountFormatted = _formatN(amount, tokenDecimals[tokenId]);

        string memory fullHex = _toHex(funder);
        bytes memory fb = bytes(fullHex);
        bytes memory shortAddr = new bytes(13);
        shortAddr[0] = fb[0];
        shortAddr[1] = fb[1];
        shortAddr[2] = fb[2];
        shortAddr[3] = fb[3];
        shortAddr[4] = fb[4];
        shortAddr[5] = fb[5];
        shortAddr[6] = ".";
        shortAddr[7] = ".";
        shortAddr[8] = ".";
        shortAddr[9] = fb[38];
        shortAddr[10] = fb[39];
        shortAddr[11] = fb[40];
        shortAddr[12] = fb[41];

        string memory tokenLabel = token == address(0) ? "USDC" : "APEX";

        string memory svg = string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220">',
                '<rect width="400" height="220" fill="#0A0F1C"/>',
                '<rect x="12" y="12" width="376" height="196" rx="14" fill="#111827" stroke="#334155"/>',
                '<text x="24" y="54" fill="#E2E8F0" font-size="22" font-family="Arial, sans-serif">I Fueled Free APEX</text>',
                '<text x="24" y="96" fill="#93C5FD" font-size="14" font-family="Arial, sans-serif">Funder: ',
                string(shortAddr),
                '</text>',
                '<text x="24" y="126" fill="#A7F3D0" font-size="14" font-family="Arial, sans-serif">Amount: ',
                amountFormatted,
                '</text>',
                '<text x="24" y="156" fill="#FDE68A" font-size="14" font-family="Arial, sans-serif">Token: ',
                tokenLabel,
                '</text>',
                '<text x="24" y="186" fill="#C4B5FD" font-size="13" font-family="Arial, sans-serif">Keeping free money alive.</text>',
                '</svg>'
            )
        );

        string memory image = string(abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes(svg))));

        string memory json = string(
            abi.encodePacked(
                '{"name":"FREEAPEX Receipt #',
                Strings.toString(tokenId),
                '","description":"Soulbound funding receipt for ApexPublicGood.","image":"',
                image,
                '","attributes":[{"trait_type":"Funder","value":"',
                fullHex,
                '"},{"trait_type":"Token","value":"',
                tokenLabel,
                '"},{"trait_type":"Amount","value":"',
                amountFormatted,
                '"}]}'
            )
        );

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    /// @notice Enforces soulbound semantics across all ERC-721 transfer paths.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function _truncate(string calldata s) internal pure returns (string memory) {
        bytes calldata b = bytes(s);
        if (b.length <= MAX_MSG_LEN) return s;

        bytes memory out = new bytes(MAX_MSG_LEN);
        for (uint256 i = 0; i < MAX_MSG_LEN; i++) {
            out[i] = b[i];
        }
        return string(out);
    }

    function _recordActivity(address funder, address token, uint256 amount, string memory message) internal {
        recentActivity[activityIndex] = Activity({
            funder: funder,
            token: token,
            amount: amount,
            message: message,
            timestamp: block.timestamp
        });
        activityIndex = (activityIndex + 1) % RING_ACTIVITY;
    }

    function _recordUniqueFunder(address funder) internal {
        if (hasFunded[funder]) return;

        hasFunded[funder] = true;
        funderCount += 1;
        recentFunders[recentFunderIndex] = funder;
        recentFunderIndex = (recentFunderIndex + 1) % RING_FUNDERS;
    }

    function _mintReceipt(address to, uint256 amount, address token, uint8 dec) internal {
        uint256 tokenId = _nextTokenId;
        _nextTokenId = tokenId + 1;

        tokenFunder[tokenId] = to;
        tokenAmount[tokenId] = amount;
        tokenToken[tokenId] = token;
        tokenDecimals[tokenId] = dec;

        _safeMint(to, tokenId);
    }

    function _formatN(uint256 amount, uint8 decimals) internal pure returns (string memory) {
        uint256 scale = 10 ** uint256(decimals);
        uint256 whole = amount / scale;
        uint256 frac;

        if (decimals >= 4) {
            frac = (amount % scale) / (10 ** uint256(decimals - 4));
        } else {
            frac = (amount % scale) * (10 ** uint256(4 - decimals));
        }

        bytes memory fracDigits = new bytes(4);
        fracDigits[3] = bytes1(uint8(48 + (frac % 10)));
        frac /= 10;
        fracDigits[2] = bytes1(uint8(48 + (frac % 10)));
        frac /= 10;
        fracDigits[1] = bytes1(uint8(48 + (frac % 10)));
        frac /= 10;
        fracDigits[0] = bytes1(uint8(48 + (frac % 10)));

        return string(abi.encodePacked(Strings.toString(whole), ".", string(fracDigits)));
    }

    function _toHex(address a) internal pure returns (string memory) {
        return Strings.toHexString(uint160(a), 20);
    }
}
