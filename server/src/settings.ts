import { TextDocument } from 'vscode-languageserver-textdocument';
import { getDocumentSettings, workspaceFolders } from './server';

export interface OpenZeppelinLSSettings {
	compilerVersion?: string;
	namespacePrefix?: string;
}

/**
 * Gets the namespace prefix from the settings or the workspace folder name.
 */
export async function getNamespacePrefix(textDocument: TextDocument) {
	const settings = await getDocumentSettings(textDocument.uri);
	let namespacePrefix = settings.namespacePrefix;

	if (!namespacePrefix) {
		console.log("No namespace prefix set. Detecting based on workspace name.");

		if (workspaceFolders.length > 0) {
			// for now we just use the folder name of the first workspace folder
			// TODO: detect project name from hardhat or foundry project?
			const folderName = workspaceFolders[0].split('/').pop()!;
			// convert whitespace to dash
			namespacePrefix = folderName.replace(/\s+/g, '-');
		}
	} else {
		console.log("Namespace prefix is: " + namespacePrefix);
	}

	return namespacePrefix ?? '';
}
