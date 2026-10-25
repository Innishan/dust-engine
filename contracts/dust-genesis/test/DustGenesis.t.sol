// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {DustGenesis} from "../src/DustGenesis.sol";
import {ICreatorToken} from "../src/ICreatorToken.sol";
import {ITransferValidator} from "../src/ITransferValidator.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {DustGenesisDeploymentConfig} from "../script/Deploy.s.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertSelector) external;
}

contract DustGenesisTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SIGNER_KEY = 0xA11CE;
    uint256 private constant REPLACEMENT_SIGNER_KEY = 0xB0B;
    address private constant CONFIRMED_DEPLOYER = 0xEe36C3c644240302eB8121F66D4e23C068512a40;
    address private constant CONFIRMED_SIGNER = 0x699C2b62196667D5D9D550C405780d3C91C84057;
    string private constant CONFIRMED_METADATA_URI =
        "ipfs://bafkreidir2sulyf2m67bvxltfhexguovjxzfdwqrggcdtehii3e5yh4wky";
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA701);
    address private constant OPERATOR = address(0x0F3A70);
    string private constant SHARED_URI = "ipfs://bafy-test-metadata-cid";
    bytes32 private constant TYPEHASH = keccak256("MintAuthorization(address recipient,bytes32 nonce,uint256 expiry)");
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    DustGenesis private nft;
    MockTransferValidator private validator;
    DustGenesisDeploymentConfigHarness private configHarness;
    address private signer;

    function setUp() public {
        signer = vm.addr(SIGNER_KEY);
        configHarness = new DustGenesisDeploymentConfigHarness();
        nft = new DustGenesis(address(this), signer, SHARED_URI);
        validator = _installValidator(address(nft));
        nft.setTransferValidator(address(validator));
        nft.activateCampaign(block.timestamp);
    }

    function testNormalMintUsesSharedMetadataAndCostsNoMintPrice() public {
        bytes32 nonce = keccak256("normal");
        uint256 expiry = block.timestamp + 5 minutes;
        bytes memory signature = _sign(SIGNER_KEY, ALICE, nonce, expiry);

        vm.prank(ALICE);
        nft.mint(nonce, expiry, signature);

        require(nft.ownerOf(1) == ALICE, "recipient mismatch");
        require(nft.hasMinted(ALICE), "wallet not marked claimed");
        require(keccak256(bytes(nft.tokenURI(1))) == keccak256(bytes(SHARED_URI)), "metadata URI mismatch");
        require(nft.authorizedSigner() == signer, "signer mismatch");
    }

    function testSafeMintAcceptsAnERC721Receiver() public {
        GenesisReceiver receiver = new GenesisReceiver(nft);
        bytes32 nonce = keccak256("safe-mint");
        uint256 expiry = block.timestamp + 5 minutes;
        receiver.claim(nonce, expiry, _sign(SIGNER_KEY, address(receiver), nonce, expiry));
        require(nft.ownerOf(1) == address(receiver), "receiver did not receive the NFT");
        require(nft.hasMinted(address(receiver)), "receiver was not marked claimed");
    }

    function testRejectingReceiverRollsBackMintAndAuthorizationState() public {
        RejectingGenesisReceiver receiver = new RejectingGenesisReceiver();
        bytes32 nonce = keccak256("rejecting-receiver");
        uint256 expiry = block.timestamp + 5 minutes;
        bytes memory signature = _sign(SIGNER_KEY, address(receiver), nonce, expiry);

        vm.expectRevert(abi.encodeWithSignature("Error(string)", "receiver rejects NFT"));
        receiver.claim(address(nft), nonce, expiry, signature);
        require(!nft.hasMinted(address(receiver)), "reverting receiver remains marked minted");
        require(!nft.usedAuthorizationNonces(nonce), "reverting receiver consumed authorization nonce");
    }

    function testAuthorizationIsValidAtExactExpiryBoundary() public {
        bytes32 nonce = keccak256("exact-expiry");
        uint256 expiry = block.timestamp + 5 minutes;
        bytes memory signature = _sign(SIGNER_KEY, ALICE, nonce, expiry);
        vm.warp(expiry);

        vm.prank(ALICE);
        nft.mint(nonce, expiry, signature);
        require(nft.hasMinted(ALICE), "authorization at expiry boundary was rejected");
    }

    function testCampaignCanBeScheduledOnceAndCannotMintBeforeItsStart() public {
        uint256 startTimestamp = block.timestamp + 100;
        nft = new DustGenesis(address(this), signer, SHARED_URI);
        nft.setTransferValidator(address(_installValidator(address(nft))));
        nft.activateCampaign(startTimestamp);
        require(nft.campaignStartTimestamp() == startTimestamp, "campaign start not stored");
        require(nft.campaignDeadline() == startTimestamp + 14 days, "campaign duration is not 14 days");

        vm.expectRevert(DustGenesis.CampaignAlreadyActivated.selector);
        nft.activateCampaign(startTimestamp + 1);

        bytes32 nonce = keccak256("before-start");
        uint256 expiry = startTimestamp + 5 minutes;
        vm.expectRevert(DustGenesis.CampaignNotStarted.selector);
        vm.prank(ALICE);
        nft.mint(nonce, expiry, _sign(SIGNER_KEY, ALICE, nonce, expiry));
    }

    function testMintingIsRejectedExactlyAtCampaignDeadline() public {
        uint256 deadline = nft.campaignDeadline();
        bytes32 nonce = keccak256("at-campaign-deadline");
        uint256 expiry = block.timestamp + 5 minutes;
        bytes memory signature = _sign(SIGNER_KEY, ALICE, nonce, expiry);
        vm.warp(deadline);

        vm.expectRevert(abi.encodeWithSelector(DustGenesis.CampaignExpired.selector, deadline));
        vm.prank(ALICE);
        nft.mint(nonce, expiry, signature);
        require(!nft.hasMinted(ALICE), "wallet marked minted at campaign deadline");
    }

    function testMintingIsRejectedAfterCampaignDeadline() public {
        uint256 deadline = nft.campaignDeadline();
        bytes32 nonce = keccak256("after-campaign-deadline");
        uint256 expiry = block.timestamp + 5 minutes;
        bytes memory signature = _sign(SIGNER_KEY, ALICE, nonce, expiry);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(DustGenesis.CampaignExpired.selector, deadline));
        vm.prank(ALICE);
        nft.mint(nonce, expiry, signature);
        require(!nft.hasMinted(ALICE), "wallet marked minted after campaign deadline");
    }

    function testPreDeadlineAuthorizationCannotMintAtCampaignDeadline() public {
        uint256 deadline = nft.campaignDeadline();
        bytes32 nonce = keccak256("authorization-crosses-campaign-deadline");
        uint256 expiry = deadline + 5 minutes;
        bytes memory signature = _sign(SIGNER_KEY, ALICE, nonce, expiry);
        vm.warp(deadline);

        vm.expectRevert(abi.encodeWithSelector(DustGenesis.CampaignExpired.selector, deadline));
        vm.prank(ALICE);
        nft.mint(nonce, expiry, signature);
        require(!nft.usedAuthorizationNonces(nonce), "deadline rejection consumed authorization");
    }

    function testConstructorRejectsZeroSignerAndEmptyMetadata() public {
        vm.expectRevert(DustGenesis.ZeroSigner.selector);
        new DustGenesis(address(this), address(0), SHARED_URI);
        vm.expectRevert(DustGenesis.EmptyMetadataURI.selector);
        new DustGenesis(address(this), signer, "");
    }

    function testCreatorTokenAndERC721InterfacesAreAdvertised() public view {
        require(nft.supportsInterface(type(ICreatorToken).interfaceId), "Creator Token interface missing");
        require(nft.supportsInterface(type(IERC721).interfaceId), "ERC721 interface regressed");
        require(nft.supportsInterface(type(IERC165).interfaceId), "ERC165 interface regressed");
    }

    function testTransferValidatorGettersAndValidationSelector() public view {
        require(nft.getTransferValidator() == address(validator), "validator getter mismatch");
        (bytes4 selector, bool isView) = nft.getTransferValidationFunction();
        require(selector == 0xcaee23ea, "wrong validation selector");
        require(isView, "validation function must be view");
    }

    function testOnlyOwnerCanConfigureTransferValidator() public {
        DustGenesis fresh = new DustGenesis(address(this), signer, SHARED_URI);
        MockTransferValidator candidate = _installValidator(address(fresh));

        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), ALICE));
        vm.prank(ALICE);
        fresh.setTransferValidator(address(candidate));

        require(fresh.getTransferValidator() == address(0), "non-owner configured validator");
    }

    function testOwnerCanConfigureAnERC165CompatibleValidator() public {
        DustGenesis fresh = new DustGenesis(address(this), signer, SHARED_URI);
        MockTransferValidator compatibleButUnapproved = new MockTransferValidator(address(fresh));
        fresh.setTransferValidator(address(compatibleButUnapproved));
        require(fresh.getTransferValidator() == address(compatibleButUnapproved), "compatible validator not set");
    }

    function testValidatorConfigurationRejectsNoCodeAddress() public {
        DustGenesis fresh = new DustGenesis(address(this), signer, SHARED_URI);
        address noCode = address(0xBAD);
        vm.expectRevert(abi.encodeWithSelector(DustGenesis.InvalidTransferValidator.selector, noCode));
        fresh.setTransferValidator(noCode);
    }

    function testValidatorConfigurationRejectsIncompatibleContract() public {
        DustGenesis fresh = new DustGenesis(address(this), signer, SHARED_URI);
        IncompatibleTransferValidator candidate = new IncompatibleTransferValidator();
        vm.expectRevert(
            abi.encodeWithSelector(DustGenesis.InvalidTransferValidator.selector, address(candidate))
        );
        fresh.setTransferValidator(address(candidate));
    }

    function testValidatorCanBeConfiguredClearedAndReconfiguredByOwner() public {
        nft.setTransferValidator(address(0));
        require(nft.getTransferValidator() == address(0), "validator was not cleared");
        nft.setTransferValidator(address(validator));
        require(nft.getTransferValidator() == address(validator), "validator was not reconfigured");
    }

    function testClearingValidatorRestoresOrdinaryTransferBehavior() public {
        _mintTo(ALICE, "transfer-after-validator-clear");
        nft.setTransferValidator(address(0));

        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, 1);
        require(nft.ownerOf(1) == BOB, "transfer failed after validator was cleared");
    }

    function testCampaignActivatesWithoutValidatorConfigured() public {
        DustGenesis fresh = new DustGenesis(address(this), signer, SHARED_URI);
        fresh.activateCampaign(block.timestamp);
        require(fresh.campaignStartTimestamp() == block.timestamp, "campaign did not activate without validator");
    }

    function testMintAndOrdinaryTransferWorkWithoutValidator() public {
        DustGenesis fresh = new DustGenesis(address(this), signer, SHARED_URI);
        fresh.activateCampaign(block.timestamp);

        bytes32 nonce = keccak256("mint-without-validator");
        uint256 expiry = block.timestamp + 5 minutes;
        vm.prank(ALICE);
        fresh.mint(nonce, expiry, _signForContract(SIGNER_KEY, ALICE, nonce, expiry, address(fresh)));
        require(fresh.ownerOf(1) == ALICE, "mint failed without validator");

        vm.prank(ALICE);
        fresh.transferFrom(ALICE, BOB, 1);
        require(fresh.ownerOf(1) == BOB, "transfer failed without validator");
    }

    function testMintDoesNotCallTransferValidator() public {
        validator.setRejectTransfers(true);
        bytes32 nonce = keccak256("validator-not-called-for-mint");
        uint256 expiry = block.timestamp + 5 minutes;

        vm.prank(ALICE);
        nft.mint(nonce, expiry, _sign(SIGNER_KEY, ALICE, nonce, expiry));
        require(nft.ownerOf(1) == ALICE, "validator was incorrectly called during mint");
    }

    function testBurnDoesNotCallTransferValidator() public {
        DustGenesisHarness harness = new DustGenesisHarness(address(this), signer, SHARED_URI);
        MockTransferValidator rejectingValidator = _installValidator(address(harness));
        harness.setTransferValidator(address(rejectingValidator));
        harness.activateCampaign(block.timestamp);
        bytes32 nonce = keccak256("validator-not-called-for-burn");
        uint256 expiry = block.timestamp + 5 minutes;
        vm.prank(ALICE);
        harness.mint(nonce, expiry, _signForContract(SIGNER_KEY, ALICE, nonce, expiry, address(harness)));

        rejectingValidator.setRejectTransfers(true);
        harness.burnForTest(1);
        require(harness.balanceOf(ALICE) == 0, "burn was incorrectly blocked by validator");
    }

    function testTransferFromValidatesCallerSenderRecipientAndTokenId() public {
        _mintTo(ALICE, "transfer-from-owner");
        validator.setExpectedTransfer(ALICE, ALICE, BOB, 1);

        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, 1);
        require(nft.ownerOf(1) == BOB, "accepted transferFrom failed");
    }

    function testTransferFromValidatesApprovedOperatorCaller() public {
        _mintTo(ALICE, "transfer-from-operator");
        validator.setExpectedTransfer(OPERATOR, ALICE, BOB, 1);
        vm.prank(ALICE);
        nft.approve(OPERATOR, 1);

        vm.prank(OPERATOR);
        nft.transferFrom(ALICE, BOB, 1);
        require(nft.ownerOf(1) == BOB, "approved operator transfer failed");
    }

    function testSafeTransferFromWithoutDataValidatesTransfer() public {
        _mintTo(ALICE, "safe-transfer-no-data");
        validator.setExpectedTransfer(ALICE, ALICE, BOB, 1);

        vm.prank(ALICE);
        nft.safeTransferFrom(ALICE, BOB, 1);
        require(nft.ownerOf(1) == BOB, "safeTransferFrom without data failed");
    }

    function testSafeTransferFromWithDataValidatesTransfer() public {
        _mintTo(ALICE, "safe-transfer-with-data");
        validator.setExpectedTransfer(ALICE, ALICE, CAROL, 1);

        vm.prank(ALICE);
        nft.safeTransferFrom(ALICE, CAROL, 1, "validator-test");
        require(nft.ownerOf(1) == CAROL, "safeTransferFrom with data failed");
    }

    function testRejectedTransferRollsBackOwnership() public {
        _mintTo(ALICE, "rejected-transfer");
        validator.setRejectTransfers(true);

        vm.expectRevert(MockTransferValidator.TransferRejected.selector);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, 1);
        require(nft.ownerOf(1) == ALICE, "rejected transfer changed ownership");
    }

    function testDuplicateMintByWalletReverts() public {
        bytes32 firstNonce = keccak256("first");
        uint256 expiry = block.timestamp + 5 minutes;
        vm.prank(ALICE);
        nft.mint(firstNonce, expiry, _sign(SIGNER_KEY, ALICE, firstNonce, expiry));

        bytes32 secondNonce = keccak256("second");
        vm.expectRevert(abi.encodeWithSelector(DustGenesis.MintAlreadyClaimed.selector, ALICE));
        vm.prank(ALICE);
        nft.mint(secondNonce, expiry, _sign(SIGNER_KEY, ALICE, secondNonce, expiry));
    }

    function testInvalidSignatureReverts() public {
        bytes32 nonce = keccak256("invalid");
        uint256 expiry = block.timestamp + 5 minutes;
        vm.expectRevert(DustGenesis.InvalidAuthorization.selector);
        vm.prank(ALICE);
        nft.mint(nonce, expiry, _sign(REPLACEMENT_SIGNER_KEY, ALICE, nonce, expiry));
    }

    function testAuthorizationCannotBeRedirectedToWrongRecipient() public {
        bytes32 nonce = keccak256("recipient");
        uint256 expiry = block.timestamp + 5 minutes;
        bytes memory aliceSignature = _sign(SIGNER_KEY, ALICE, nonce, expiry);

        vm.expectRevert(DustGenesis.InvalidAuthorization.selector);
        vm.prank(BOB);
        nft.mint(nonce, expiry, aliceSignature);
        require(!nft.hasMinted(BOB), "wrong recipient was minted");
    }

    function testExpiredAuthorizationReverts() public {
        bytes32 nonce = keccak256("expired");
        uint256 expiry = block.timestamp + 1;
        bytes memory signature = _sign(SIGNER_KEY, ALICE, nonce, expiry);
        vm.warp(expiry + 1);

        vm.expectRevert(abi.encodeWithSelector(DustGenesis.AuthorizationExpired.selector, expiry));
        vm.prank(ALICE);
        nft.mint(nonce, expiry, signature);
    }

    function testAuthorizationCannotOutliveMaximumLifetime() public {
        bytes32 nonce = keccak256("long-lived");
        uint256 expiry = block.timestamp + 5 minutes + 1;
        bytes memory signature = _sign(SIGNER_KEY, ALICE, nonce, expiry);
        vm.expectRevert(abi.encodeWithSelector(DustGenesis.AuthorizationLifetimeTooLong.selector, expiry));
        vm.prank(ALICE);
        nft.mint(nonce, expiry, signature);
    }

    function testAuthorizationNonceCannotBeReplayedAcrossWallets() public {
        bytes32 nonce = keccak256("replay");
        uint256 expiry = block.timestamp + 5 minutes;
        vm.prank(ALICE);
        nft.mint(nonce, expiry, _sign(SIGNER_KEY, ALICE, nonce, expiry));

        vm.expectRevert(abi.encodeWithSelector(DustGenesis.AuthorizationNonceAlreadyUsed.selector, nonce));
        vm.prank(BOB);
        nft.mint(nonce, expiry, _sign(SIGNER_KEY, BOB, nonce, expiry));
    }

    function testAuthorizationIsBoundToChainAndContract() public {
        bytes32 chainNonce = keccak256("wrong-chain");
        uint256 expiry = block.timestamp + 5 minutes;
        bytes memory wrongChainSignature = _signForDomain(SIGNER_KEY, ALICE, chainNonce, expiry, block.chainid + 1, address(nft));
        vm.expectRevert(DustGenesis.InvalidAuthorization.selector);
        vm.prank(ALICE);
        nft.mint(chainNonce, expiry, wrongChainSignature);

        bytes32 contractNonce = keccak256("wrong-contract");
        bytes memory wrongContractSignature = _signForDomain(SIGNER_KEY, ALICE, contractNonce, expiry, block.chainid, address(0x1234));
        vm.expectRevert(DustGenesis.InvalidAuthorization.selector);
        vm.prank(ALICE);
        nft.mint(contractNonce, expiry, wrongContractSignature);
    }

    function testOnlyOwnerCanChangeSignerAndNewSignerIsUsed() public {
        address replacement = vm.addr(REPLACEMENT_SIGNER_KEY);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), ALICE));
        vm.prank(ALICE);
        nft.setAuthorizedSigner(replacement);

        nft.setAuthorizedSigner(replacement);
        require(nft.authorizedSigner() == replacement, "signer did not rotate");
        bytes32 nonce = keccak256("rotated");
        uint256 expiry = block.timestamp + 5 minutes;
        vm.prank(ALICE);
        nft.mint(nonce, expiry, _sign(REPLACEMENT_SIGNER_KEY, ALICE, nonce, expiry));
    }

    function testOwnerCannotSetZeroSigner() public {
        vm.expectRevert(DustGenesis.ZeroSigner.selector);
        nft.setAuthorizedSigner(address(0));
    }

    function testOwnerCannotRenounceTheAbilityToCloseMinting() public {
        vm.expectRevert(DustGenesis.OwnershipRenunciationDisabled.selector);
        nft.renounceOwnership();
        require(nft.owner() == address(this), "owner unexpectedly renounced");
    }

    function testDeploymentConfigAcceptsOnlyConfirmedBaseConfiguration() public {
        _validateDeploymentConfiguration(
            8453,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            CONFIRMED_SIGNER,
            CONFIRMED_SIGNER,
            CONFIRMED_METADATA_URI
        );
    }

    function testDeploymentConfigRejectsWrongChain() public {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "Base Mainnet (8453) required"));
        _validateDeploymentConfig(84531, CONFIRMED_DEPLOYER, CONFIRMED_DEPLOYER, CONFIRMED_SIGNER, CONFIRMED_METADATA_URI);
    }

    function testDeploymentConfigRejectsWrongDeployer() public {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "Unexpected deployer address"));
        _validateDeploymentConfig(8453, ALICE, CONFIRMED_DEPLOYER, CONFIRMED_SIGNER, CONFIRMED_METADATA_URI);
    }

    function testDeploymentConfigRejectsWrongExpectedDeployer() public {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "Unexpected deployer address"));
        _validateDeploymentConfiguration(
            8453,
            CONFIRMED_DEPLOYER,
            ALICE,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            CONFIRMED_SIGNER,
            CONFIRMED_SIGNER,
            CONFIRMED_METADATA_URI
        );
    }

    function testDeploymentConfigRejectsWrongInitialOwner() public {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "Unexpected owner address"));
        _validateDeploymentConfiguration(
            8453,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            ALICE,
            CONFIRMED_DEPLOYER,
            CONFIRMED_SIGNER,
            CONFIRMED_SIGNER,
            CONFIRMED_METADATA_URI
        );
    }

    function testDeploymentConfigRejectsWrongExpectedOwner() public {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "Unexpected owner address"));
        _validateDeploymentConfiguration(
            8453,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            ALICE,
            CONFIRMED_SIGNER,
            CONFIRMED_SIGNER,
            CONFIRMED_METADATA_URI
        );
    }

    function testDeploymentConfigRejectsWrongSigner() public {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "Unexpected signer address"));
        _validateDeploymentConfig(8453, CONFIRMED_DEPLOYER, CONFIRMED_DEPLOYER, ALICE, CONFIRMED_METADATA_URI);
    }

    function testDeploymentConfigRejectsWrongMetadataURI() public {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "Unexpected metadata URI"));
        _validateDeploymentConfig(8453, CONFIRMED_DEPLOYER, CONFIRMED_DEPLOYER, CONFIRMED_SIGNER, "ipfs://placeholder");
    }

    function _validateDeploymentConfig(
        uint256 chainId,
        address deployer,
        address expectedOwner,
        address initialSigner,
        string memory metadataURI
    ) private {
        _validateDeploymentConfiguration(
            chainId,
            deployer,
            CONFIRMED_DEPLOYER,
            CONFIRMED_DEPLOYER,
            expectedOwner,
            initialSigner,
            CONFIRMED_SIGNER,
            metadataURI
        );
    }

    function _validateDeploymentConfiguration(
        uint256 chainId,
        address derivedDeployer,
        address expectedDeployer,
        address initialOwner,
        address expectedOwner,
        address initialSigner,
        address expectedSigner,
        string memory metadataURI
    ) private view {
        configHarness.validate(
            chainId,
            derivedDeployer,
            expectedDeployer,
            initialOwner,
            expectedOwner,
            initialSigner,
            expectedSigner,
            metadataURI
        );
    }

    function testMintClosureIsPermanentAndOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), ALICE));
        vm.prank(ALICE);
        nft.closeMintingPermanently();

        nft.closeMintingPermanently();
        require(nft.mintingClosed(), "closure not recorded");

        bytes32 nonce = keccak256("after-close");
        uint256 expiry = block.timestamp + 5 minutes;
        vm.expectRevert(DustGenesis.MintingPermanentlyClosed.selector);
        vm.prank(ALICE);
        nft.mint(nonce, expiry, _sign(SIGNER_KEY, ALICE, nonce, expiry));

        vm.expectRevert(DustGenesis.MintingPermanentlyClosed.selector);
        nft.closeMintingPermanently();
        require(nft.mintingClosed(), "closure was reopened");
    }

    function _sign(uint256 privateKey, address recipient, bytes32 nonce, uint256 expiry) private returns (bytes memory) {
        return _signForDomain(privateKey, recipient, nonce, expiry, block.chainid, address(nft));
    }

    function _mintTo(address recipient, string memory nonceLabel) private {
        bytes32 nonce = keccak256(bytes(nonceLabel));
        uint256 expiry = block.timestamp + 5 minutes;
        vm.prank(recipient);
        nft.mint(nonce, expiry, _sign(SIGNER_KEY, recipient, nonce, expiry));
    }

    function _installValidator(address collection) private returns (MockTransferValidator installed) {
        installed = new MockTransferValidator(collection);
    }

    function _signForContract(
        uint256 privateKey,
        address recipient,
        bytes32 nonce,
        uint256 expiry,
        address verifyingContract
    ) private returns (bytes memory) {
        return _signForDomain(privateKey, recipient, nonce, expiry, block.chainid, verifyingContract);
    }

    function _signForDomain(
        uint256 privateKey,
        address recipient,
        bytes32 nonce,
        uint256 expiry,
        uint256 chainId,
        address verifyingContract
    ) private returns (bytes memory) {
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes("Dust Genesis")),
            keccak256(bytes("1")),
            chainId,
            verifyingContract
        ));
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, recipient, nonce, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract DustGenesisDeploymentConfigHarness {
    function validate(
        uint256 chainId,
        address derivedDeployer,
        address expectedDeployer,
        address initialOwner,
        address expectedOwner,
        address initialSigner,
        address expectedSigner,
        string calldata metadataURI
    ) external pure {
        DustGenesisDeploymentConfig.validate(
            chainId,
            derivedDeployer,
            expectedDeployer,
            initialOwner,
            expectedOwner,
            initialSigner,
            expectedSigner,
            metadataURI
        );
    }
}

contract MockTransferValidator {
    error TransferRejected();
    error UnexpectedTransferArguments();

    address private immutable _collection;
    bool private _rejectTransfers;
    bool private _checkExpectedTransfer;
    address private _expectedCaller;
    address private _expectedFrom;
    address private _expectedTo;
    uint256 private _expectedTokenId;

    constructor(address collection) {
        _collection = collection;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(ITransferValidator).interfaceId;
    }

    function setRejectTransfers(bool rejectTransfers) external {
        _rejectTransfers = rejectTransfers;
    }

    function setExpectedTransfer(address caller, address from, address to, uint256 tokenId) external {
        _checkExpectedTransfer = true;
        _expectedCaller = caller;
        _expectedFrom = from;
        _expectedTo = to;
        _expectedTokenId = tokenId;
    }

    function validateTransfer(address caller, address from, address to, uint256 tokenId) external view {
        if (msg.sender != _collection) revert UnexpectedTransferArguments();
        if (_rejectTransfers) revert TransferRejected();
        if (
            _checkExpectedTransfer
                && (caller != _expectedCaller || from != _expectedFrom || to != _expectedTo || tokenId != _expectedTokenId)
        ) revert UnexpectedTransferArguments();
    }
}

contract IncompatibleTransferValidator {
    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }

    function validateTransfer(address, address, address, uint256) external pure {}
}

contract DustGenesisHarness is DustGenesis {
    constructor(address initialOwner, address initialSigner, string memory metadataURI)
        DustGenesis(initialOwner, initialSigner, metadataURI)
    {}

    function burnForTest(uint256 tokenId) external {
        _burn(tokenId);
    }
}

contract GenesisReceiver is IERC721Receiver {
    DustGenesis private immutable _nft;

    constructor(DustGenesis nft_) {
        _nft = nft_;
    }

    function claim(bytes32 nonce, uint256 expiry, bytes calldata signature) external {
        _nft.mint(nonce, expiry, signature);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract RejectingGenesisReceiver {
    function claim(address nft, bytes32 nonce, uint256 expiry, bytes calldata signature) external {
        DustGenesis(nft).mint(nonce, expiry, signature);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("receiver rejects NFT");
    }
}
