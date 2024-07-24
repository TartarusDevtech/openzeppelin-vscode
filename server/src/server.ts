/* --------------------------------------------------------------------------------------------
 * Copyright for portions from https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample
 * are held by (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * 
 * Copyright (c) 2024 OpenZeppelin
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentDiagnosticReportKind,
	type DocumentDiagnosticReport,
	CodeActionKind,
	CodeActionParams,
	CodeAction,
	CodeActionContext,
	LSPAny,
	WorkspaceEdit
} from 'vscode-languageserver/node';

import {
	Range,
	TextDocument,
	TextEdit} from 'vscode-languageserver-textdocument';

import { NonterminalKind } from "@nomicfoundation/slang/kinds";
import { Variable } from './namespace';
import { Language } from '@nomicfoundation/slang/language';

import { URI } from 'vscode-uri';
import { CONTRACT_CAN_BE_NAMESPACED, NAMESPACE_HASH_MISMATCH, NAMESPACE_ID_MISMATCH, NAMESPACE_ID_MISMATCH_HASH_COMMENT, NAMESPACE_STANDALONE_HASH_MISMATCH, validateNamespaces } from './diagnostics';
import { getMoveAllVariablesToNamespaceQuickFix } from './quickfixes';
import { getNamespacePrefix, OpenZeppelinLSSettings } from './settings';
import { inferSolidityVersion } from './solidityVersion';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

export let workspaceFolders: string[] = [];

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	if (hasWorkspaceFolderCapability && params.workspaceFolders != null) {
		params.workspaceFolders.forEach(folder => {
			workspaceFolders.push(URI.parse(folder.uri).fsPath);
			// workspaceFolders.push(uri2path(folder.uri));
		});
		connection.console.log(`Workspace folders: ${workspaceFolders}`);
	}

	if (workspaceFolders.length == null && params.rootUri != null) {
		// workspaceFolders.push(uri2path(params.rootUri));
		workspaceFolders.push(URI.parse(params.rootUri).fsPath);
	}

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false
			},
			codeActionProvider : {
				codeActionKinds : [ CodeActionKind.QuickFix ]
			},
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: OpenZeppelinLSSettings = { solidityVersion: "", namespacePrefix: "" };
let globalSettings: OpenZeppelinLSSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<OpenZeppelinLSSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <OpenZeppelinLSSettings>(
			(change.settings.openzeppelinLS || defaultSettings)
		);
	}
	// Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
	// We could optimize things here and re-fetch the setting first can compare it
	// to the existing setting, but this is out of scope for this example.
	connection.languages.diagnostics.refresh();
});

export function getDocumentSettings(resource: string): Thenable<OpenZeppelinLSSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'openzeppelinLS'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});


connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(document)
		} satisfies DocumentDiagnosticReport;
	} else {
		// We don't know the document. We can either try to read it from disk
		// or we don't report problems for it.
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: []
		} satisfies DocumentDiagnosticReport;
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

export type NamespaceableContract = {
	name: string;
	variables: Variable[];
}

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
	const diagnostics: Diagnostic[] = [];

	const language = new Language(await inferSolidityVersion(textDocument, workspaceFolders));
	const parseOutput = language.parse(NonterminalKind.SourceUnit, textDocument.getText());

	await validateNamespaces(parseOutput, language, textDocument, diagnostics);

	return diagnostics;
}

export function addDiagnostic(diagnostics: Diagnostic[], textDocument: TextDocument, range: Range, message: string, details: string, severity: DiagnosticSeverity, code: string, data: LSPAny) {
	let diagnostic: Diagnostic = {
		severity: severity,
		range: range,
		message: message,
		source: "OpenZeppelin Language Server",
		code: code,
		data: data,
	};
	if (hasDiagnosticRelatedInformationCapability) {
		diagnostic.relatedInformation = [
			{
				location: {
					uri: textDocument.uri,
					range: Object.assign({}, diagnostic.range)
				},
				message: details
			}
		];
	}
	diagnostics.push(diagnostic);
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received a file change event');
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();


connection.onCodeAction(
	async (_params: CodeActionParams): Promise<CodeAction[]> => {
		let codeActions : CodeAction[] = [];

		let textDocument = documents.get(_params.textDocument.uri)
		if (textDocument === undefined) {
			return codeActions;
		}
		let context : CodeActionContext = _params.context;
		let diagnostics : Diagnostic[] = context.diagnostics;

		codeActions = await getCodeActions(diagnostics, textDocument, _params);

		return codeActions;
	}
)

async function getCodeActions(diagnostics: Diagnostic[], textDocument: TextDocument, params: CodeActionParams) : Promise<CodeAction[]> {
	let codeActions : CodeAction[] = [];
	try {	
		for (let i = 0; i < diagnostics.length; i++) {
			let diagnostic = diagnostics[i];
			if (String(diagnostic.code) === NAMESPACE_ID_MISMATCH) {
				let title : string = "Replace namespace id";
				let range : Range = diagnostic.range;
				let replacement : string = String(diagnostic.data.replacement);
				codeActions.push(getQuickFixReplacement([diagnostic], title, range, replacement, textDocument));
			} else if (String(diagnostic.code) === NAMESPACE_ID_MISMATCH_HASH_COMMENT) {
				let title : string = "Replace namespace comment";
				let range : Range = diagnostic.range;
				let replacement : string = String(diagnostic.data.replacement);
				codeActions.push(getQuickFixReplacement([diagnostic], title, range, replacement, textDocument));
			} else if (String(diagnostic.code) === NAMESPACE_HASH_MISMATCH) {
				let title : string = "Recalculate hash using comment";
				let range : Range = diagnostic.range;
				let replacement : string = String(diagnostic.data.replacement);
				codeActions.push(getQuickFixReplacement([diagnostic], title, range, replacement, textDocument));
			} else if (String(diagnostic.code) === NAMESPACE_STANDALONE_HASH_MISMATCH) {
				let title : string = "Recalculate hash using expected id";
				let range : Range = diagnostic.range;
				let replacement : string = String(diagnostic.data.replacement);
				codeActions.push(getQuickFixReplacement([diagnostic], title, range, replacement, textDocument));
			} else if (String(diagnostic.code) === CONTRACT_CAN_BE_NAMESPACED) {
				const title = "Move all variables to namespace";
				const prefix = await getNamespacePrefix(textDocument);;
				const contractName = (diagnostic.data as NamespaceableContract).name;
				const quickfix = await getMoveAllVariablesToNamespaceQuickFix(diagnostics, title, prefix, contractName, (diagnostic.data as NamespaceableContract).variables, textDocument); // this fixes all diagnostics in scope
				if (quickfix !== undefined) {
					codeActions.push(quickfix);
				}
			}
		}
	} catch (e) {
		console.error(e);
	}

	return codeActions;
}

function getQuickFixReplacement(fixesDiagnostics: Diagnostic[], title: string, range: Range, replacement: string, textDocument: TextDocument): CodeAction {
	let textEdit: TextEdit = {
		range: range,
		newText: replacement
	};
	let workspaceEdit: WorkspaceEdit = {
		changes: { [textDocument.uri]: [textEdit] }
	};
	let codeAction: CodeAction = {
		title: title,
		kind: CodeActionKind.QuickFix,
		edit: workspaceEdit,
		diagnostics: fixesDiagnostics,
	};
	return codeAction;
}
