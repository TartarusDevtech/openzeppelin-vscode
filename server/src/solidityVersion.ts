
import { TextDocument} from 'vscode-languageserver-textdocument';

import { Language } from '@nomicfoundation/slang/language';

import { getHighestSupportedPragmaVersion } from './helpers/slang';
import { getDocumentSettings } from './server';

import path from 'path';
import { promises as fs } from 'fs';

/**
 * Tries to infer the Solidity version in the following order:
 * 1. From the language server settings
 * 2. From Foundry config
 * 3. From Hardhat config
 * 4. From pragma statement
 */
export async function inferSolidityVersion(textDocument: TextDocument, workspaceFolders: string[]): Promise<string> {
	const versionFromSetting = (await getDocumentSettings(textDocument.uri)).compilerVersion;
	if (versionFromSetting && versionFromSetting.trim().length > 0) {
		console.log("Using Solidity version from settings: " + versionFromSetting);
		return versionFromSetting;
	}

	const versionFromFoundry = await inferSolidityVersionFromFoundry(workspaceFolders);
	if (versionFromFoundry) {
		console.log("Using Solidity version from Foundry config: " + versionFromFoundry);
		return versionFromFoundry;
	}

	const versionFromHardhat = await inferSolidityVersionFromHardhat(workspaceFolders);
	if (versionFromHardhat) {
		console.log("Using Solidity version from Hardhat config: " + versionFromHardhat);
		return versionFromHardhat;
	}
	
	const versionFromPragma = getHighestSupportedPragmaVersion(textDocument);
	if (versionFromPragma) {
		console.log("Using Solidity version from pragma: " + versionFromPragma);
		return versionFromPragma;
	}

	console.error("Could not determine Solidity version from pragma. Using latest version.");
	return Language.supportedVersions()[Language.supportedVersions().length - 1];
}

async function inferSolidityVersionFromFoundry(workspaceFolders: string[]) {
	const regex = /solc\s*=\s*["']([^"']+)["']/;

	if (workspaceFolders.length > 0) {
		for (const workspaceFolder of workspaceFolders) {
			const foundryConfigPath = path.join(workspaceFolder, 'foundry.toml');
			const version = await inferVersionFromConfig(foundryConfigPath, regex);
			if (version) {
				return version;
			}
		}
	}
	return undefined;
}

async function inferSolidityVersionFromHardhat(workspaceFolders: string[]) {
	const regex = /solidity:[\s]*{[\s]*version:[\s]*["']([^"']+)["']/;

	if (workspaceFolders.length > 0) {
		for (const workspaceFolder of workspaceFolders) {
			const hardhatConfigTsPath = path.join(workspaceFolder, 'hardhat.config.ts');
			const versionTs = await inferVersionFromConfig(hardhatConfigTsPath, regex);
			if (versionTs) {
				return versionTs;
			}

			const hardhatConfigJsPath = path.join(workspaceFolder, 'hardhat.config.js');
			const versionJs = await inferVersionFromConfig(hardhatConfigJsPath, regex);
			if (versionJs) {
				return versionJs;
			}
		}
	}
	return undefined;
}

async function inferVersionFromConfig(filePath: string, regex: RegExp) {
	if (await exists(filePath)) {
		const configFile = await fs.readFile(filePath, 'utf8');

		const solidityVersion = configFile.match(regex);
		if (solidityVersion && solidityVersion[1]) {
			return solidityVersion[1];
		} else {
			return undefined;
		}
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (e: any) {
		return false;
	}
}