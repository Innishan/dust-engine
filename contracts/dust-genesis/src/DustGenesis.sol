// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICreatorToken} from "./ICreatorToken.sol";
import {ITransferValidator} from "./ITransferValidator.sol";

/// @title Dust Genesis
/// @notice Free, single-mint-per-wallet ERC-721 with server-authorized campaign claims.
contract DustGenesis is ERC721, Ownable2Step, EIP712, ICreatorToken {
    bytes32 public constant MINT_AUTHORIZATION_TYPEHASH =
        keccak256("MintAuthorization(address recipient,bytes32 nonce,uint256 expiry)");
    uint256 public constant MAX_AUTHORIZATION_TTL = 5 minutes;
    uint256 public constant CAMPAIGN_DURATION = 14 days;

    error MintingPermanentlyClosed();
    error MintAlreadyClaimed(address wallet);
    error AuthorizationExpired(uint256 expiry);
    error AuthorizationLifetimeTooLong(uint256 expiry);
    error InvalidAuthorization();
    error AuthorizationNonceAlreadyUsed(bytes32 nonce);
    error ZeroSigner();
    error EmptyMetadataURI();
    error OwnershipRenunciationDisabled();
    error CampaignAlreadyActivated();
    error InvalidCampaignStart(uint256 startTimestamp);
    error CampaignNotStarted();
    error CampaignExpired(uint256 deadline);
    error InvalidTransferValidator(address validator);

    event DustGenesisMinted(address indexed recipient, uint256 indexed tokenId, bytes32 indexed authorizationNonce);
    event AuthorizedSignerChanged(address indexed previousSigner, address indexed newSigner);
    event MintingPermanentlyClosedEvent(address indexed owner);
    event CampaignActivated(uint256 indexed startTimestamp, uint256 indexed deadline);

    address public authorizedSigner;
    string private _sharedMetadataURI;
    uint256 private _nextTokenId = 1;
    bool public mintingClosed;
    uint256 public campaignStartTimestamp;
    address private _transferValidator;

    mapping(address wallet => bool claimed) public hasMinted;
    mapping(bytes32 nonce => bool used) public usedAuthorizationNonces;

    constructor(
        address initialOwner,
        address initialSigner,
        string memory sharedMetadataURI
    )
        ERC721("Dust Genesis", "DUSTGENESIS")
        Ownable(initialOwner)
        EIP712("Dust Genesis", "1")
    {
        if (initialSigner == address(0)) revert ZeroSigner();
        if (bytes(sharedMetadataURI).length == 0) revert EmptyMetadataURI();
        authorizedSigner = initialSigner;
        _sharedMetadataURI = sharedMetadataURI;
    }

    /// @notice Mint one NFT to the caller using a short-lived EIP-712 authorization.
    /// @dev EIP-712 binds the digest to this chain and this contract. The caller is the
    ///      recipient, so the signature cannot be redirected to another wallet.
    function mint(bytes32 nonce, uint256 expiry, bytes calldata signature) external {
        if (mintingClosed) revert MintingPermanentlyClosed();
        uint256 startTimestamp = campaignStartTimestamp;
        if (startTimestamp == 0 || block.timestamp < startTimestamp) revert CampaignNotStarted();
        uint256 deadline = startTimestamp + CAMPAIGN_DURATION;
        if (block.timestamp >= deadline) revert CampaignExpired(deadline);
        if (hasMinted[msg.sender]) revert MintAlreadyClaimed(msg.sender);
        if (block.timestamp > expiry) revert AuthorizationExpired(expiry);
        if (expiry > block.timestamp + MAX_AUTHORIZATION_TTL) revert AuthorizationLifetimeTooLong(expiry);
        if (usedAuthorizationNonces[nonce]) revert AuthorizationNonceAlreadyUsed(nonce);

        bytes32 structHash = keccak256(abi.encode(MINT_AUTHORIZATION_TYPEHASH, msg.sender, nonce, expiry));
        address recoveredSigner = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recoveredSigner != authorizedSigner) revert InvalidAuthorization();

        // Set both guards before safe mint's receiver callback. A callback failure reverts
        // this transaction and rolls these writes back together with the mint.
        hasMinted[msg.sender] = true;
        usedAuthorizationNonces[nonce] = true;

        uint256 tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);
        emit DustGenesisMinted(msg.sender, tokenId, nonce);
    }

    /// @notice Configure the campaign start exactly once, independently of deployment time.
    /// @dev The start may be scheduled in the future, but can never be changed after activation.
    function activateCampaign(uint256 startTimestamp) external onlyOwner {
        if (campaignStartTimestamp != 0) revert CampaignAlreadyActivated();
        if (mintingClosed) revert MintingPermanentlyClosed();
        if (startTimestamp == 0 || startTimestamp < block.timestamp) revert InvalidCampaignStart(startTimestamp);
        campaignStartTimestamp = startTimestamp;
        emit CampaignActivated(startTimestamp, startTimestamp + CAMPAIGN_DURATION);
    }

    /// @notice Configure or clear the optional transfer validator.
    /// @dev Only the owner can change transfer policy. Nonzero validators must have code
    ///      and advertise the expected ERC-165 interface. This does not assert OpenSea
    ///      compatibility; that must be verified for the selected validator separately.
    function setTransferValidator(address validator) external override onlyOwner {
        if (validator != address(0) && !_isValidTransferValidator(validator)) {
            revert InvalidTransferValidator(validator);
        }

        address previousValidator = _transferValidator;
        _transferValidator = validator;
        emit TransferValidatorUpdated(previousValidator, validator);
    }

    function getTransferValidator() external view override returns (address validator) {
        return _transferValidator;
    }

    function getTransferValidationFunction()
        external
        pure
        override
        returns (bytes4 functionSignature, bool isViewFunction)
    {
        return (bytes4(keccak256("validateTransfer(address,address,address,uint256)")), true);
    }

    function _isValidTransferValidator(address validator) private view returns (bool) {
        if (validator == address(0) || validator.code.length == 0) return false;

        try IERC165(validator).supportsInterface(type(ITransferValidator).interfaceId) returns (bool supported) {
            return supported;
        } catch {
            return false;
        }
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721) returns (bool) {
        return interfaceId == type(ICreatorToken).interfaceId || super.supportsInterface(interfaceId);
    }

    function campaignDeadline() public view returns (uint256) {
        uint256 startTimestamp = campaignStartTimestamp;
        return startTimestamp == 0 ? 0 : startTimestamp + CAMPAIGN_DURATION;
    }

    /// @notice Permanently disable all future mints. There is deliberately no reopen path.
    function closeMintingPermanently() external onlyOwner {
        if (mintingClosed) revert MintingPermanentlyClosed();
        mintingClosed = true;
        emit MintingPermanentlyClosedEvent(msg.sender);
    }

    /// @notice Rotate the backend authorization signer if its key must be replaced.
    function setAuthorizedSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroSigner();
        address previousSigner = authorizedSigner;
        authorizedSigner = newSigner;
        emit AuthorizedSignerChanged(previousSigner, newSigner);
    }

    /// @dev Renunciation would permanently remove the only authority able to close minting.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /// @notice Every token in the collection points to the same immutable metadata URI.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _sharedMetadataURI;
    }

    /// @dev OpenZeppelin 5's unified hook is used so every ERC-721 transfer path is checked.
    ///      Mint and burn transitions intentionally bypass the external validator.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            address validator = _transferValidator;
            if (validator != address(0)) {
                ITransferValidator(validator).validateTransfer(msg.sender, from, to, tokenId);
            }
        }
        return super._update(to, tokenId, auth);
    }
}
