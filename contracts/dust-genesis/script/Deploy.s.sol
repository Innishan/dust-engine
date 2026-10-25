// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {DustGenesis} from "../src/DustGenesis.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function envString(string calldata name) external returns (string memory);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

library DustGenesisDeploymentConfig {
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8453;
    address internal constant CONFIRMED_DEPLOYER = 0xEe36C3c644240302eB8121F66D4e23C068512a40;
    address internal constant CONFIRMED_OWNER = 0xEe36C3c644240302eB8121F66D4e23C068512a40;
    address internal constant CONFIRMED_SIGNER = 0x699C2b62196667D5D9D550C405780d3C91C84057;
    string internal constant CONFIRMED_METADATA_URI =
        "ipfs://bafkreidir2sulyf2m67bvxltfhexguovjxzfdwqrggcdtehii3e5yh4wky";

    function validate(
        uint256 chainId,
        address derivedDeployer,
        address expectedDeployer,
        address initialOwner,
        address expectedOwner,
        address initialSigner,
        address expectedSigner,
        string memory metadataURI
    ) internal pure {
        require(chainId == BASE_MAINNET_CHAIN_ID, "Base Mainnet (8453) required");
        require(
            derivedDeployer == CONFIRMED_DEPLOYER && expectedDeployer == CONFIRMED_DEPLOYER,
            "Unexpected deployer address"
        );
        require(
            initialOwner != address(0) && initialOwner == CONFIRMED_OWNER && expectedOwner == CONFIRMED_OWNER,
            "Unexpected owner address"
        );
        require(
            initialSigner != address(0) && initialSigner == CONFIRMED_SIGNER && expectedSigner == CONFIRMED_SIGNER,
            "Unexpected signer address"
        );
        require(keccak256(bytes(metadataURI)) == keccak256(bytes(CONFIRMED_METADATA_URI)), "Unexpected metadata URI");
    }
}

contract DeployDustGenesis {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant BASE_MAINNET_CHAIN_ID = 8453;

    function run() external returns (DustGenesis deployed) {
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "Base Mainnet (8453) required");

        uint256 deployerKey = vm.envUint("DUST_GENESIS_DEPLOYER_PRIVATE_KEY");
        address expectedDeployer = vm.envAddress("DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS");
        address initialOwner = vm.envAddress("DUST_GENESIS_OWNER_ADDRESS");
        address expectedOwner = vm.envAddress("DUST_GENESIS_EXPECTED_OWNER_ADDRESS");
        address initialSigner = vm.envAddress("DUST_GENESIS_SIGNER_ADDRESS");
        address expectedSigner = vm.envAddress("DUST_GENESIS_EXPECTED_SIGNER_ADDRESS");
        string memory metadataURI = vm.envString("DUST_GENESIS_METADATA_URI");

        require(deployerKey != 0, "Deployer key is required");
        DustGenesisDeploymentConfig.validate(
            block.chainid,
            vm.addr(deployerKey),
            expectedDeployer,
            initialOwner,
            expectedOwner,
            initialSigner,
            expectedSigner,
            metadataURI
        );
        require(!_isPlaceholderMetadataURI(metadataURI), "Metadata URI is empty or a placeholder");

        vm.startBroadcast(deployerKey);
        deployed = new DustGenesis(initialOwner, initialSigner, metadataURI);
        vm.stopBroadcast();
    }

    function _isPlaceholderMetadataURI(string memory uri) private pure returns (bool) {
        bytes memory value = bytes(uri);
        bool hasNonWhitespace;
        for (uint256 i; i < value.length; ++i) {
            if (value[i] == "<" || value[i] == ">") return true;
            if (value[i] > 0x20) hasNonWhitespace = true;
        }
        if (!hasNonWhitespace) return true;
        return _containsIgnoreCase(value, bytes("placeholder"))
            || _containsIgnoreCase(value, bytes("bafy-test-metadata-cid"))
            || _containsIgnoreCase(value, bytes("todo"));
    }

    function _containsIgnoreCase(bytes memory value, bytes memory marker) private pure returns (bool) {
        if (marker.length > value.length) return false;
        for (uint256 i; i <= value.length - marker.length; ++i) {
            bool matches = true;
            for (uint256 j; j < marker.length; ++j) {
                uint8 actual = uint8(value[i + j]);
                uint8 expected = uint8(marker[j]);
                if (actual >= 65 && actual <= 90) actual += 32;
                if (actual != expected) {
                    matches = false;
                    break;
                }
            }
            if (matches) return true;
        }
        return false;
    }
}
