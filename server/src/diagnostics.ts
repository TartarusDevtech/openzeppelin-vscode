import {
	Diagnostic,
	DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { NonterminalKind, TerminalKind } from "@nomicfoundation/slang/kinds";
import { calculateERC7201StorageLocation, getNamespaceId } from './namespace';
import { Language } from '@nomicfoundation/slang/language';
import assert = require('node:assert');
import { NonterminalNode, TerminalNode } from '@nomicfoundation/slang/cst';
import { ContractDefinition, FunctionDefinition, StateVariableDefinition } from '@nomicfoundation/slang/ast';
import { cursor, parse_output } from '@nomicfoundation/slang';
import { slangToVSCodeRange, getTrimmedRange, getNatSpec, getLastPrecedingTriviaWithKinds } from './helpers/slang';
import { NamespaceableContract, addDiagnostic, getSolidityVersion, getNamespacePrefix } from './server';

export const VARIABLE_CAN_BE_NAMESPACED = "VariableCanBeNamespaced";
export const CONTRACT_CAN_BE_NAMESPACED = "ContractCanBeNamespaced";
export const NAMESPACE_ID_MISMATCH = "NamespaceIdMismatch";
export const NAMESPACE_ID_MISMATCH_HASH_COMMENT = "NamespaceIdMismatchHashComment";
export const NAMESPACE_HASH_MISMATCH = "NamespaceHashMismatch";
export const NAMESPACE_STANDALONE_HASH_MISMATCH = "NamespaceStandaloneHashMismatch";
export const VARIABLE_HAS_INITIAL_VALUE = "VariableHasInitialValue";

function getExpectedNamespaceId(namespacePrefix: string, contractDef: ContractDefinition) {
	return getNamespaceId(namespacePrefix, contractDef.name.text);
}

export async function validateNamespaces(parseOutput: parse_output.ParseOutput, language: Language, textDocument: TextDocument, diagnostics: Diagnostic[]) {
	const cursor = parseOutput.createTreeCursor();
	while (cursor.goToNextNonterminalWithKind(NonterminalKind.ContractDefinition)) {
		const cursorNode = cursor.node();
		assert(cursorNode instanceof NonterminalNode);
		const contractDef = new ContractDefinition(cursorNode);


		const parseContract = language.parse(NonterminalKind.ContractDefinition, cursorNode.unparse());
		if (!parseContract.isValid) {
			console.log("Contract has errors");
			continue;
		} else {
			console.log("Parsing contract: " + contractDef.name.text);
		}

		const namespaceableContract: NamespaceableContract = {
			name: contractDef.name.text,
			variables: []
		};

		const inferredUpgradeable = inferUpgradeable(cursor, contractDef);
		if (inferredUpgradeable) {
			await validateNamespaceStructAnnotation(cursor, textDocument, contractDef, diagnostics);
			await validateNamespaceCommentAndHash(cursor, textDocument, contractDef, diagnostics);
		}
		await validateNamespaceableVariables(cursor, textDocument, diagnostics, namespaceableContract, !inferredUpgradeable);
		validateNamespaceableContract(cursor, diagnostics, textDocument, namespaceableContract);
	}
}

/**
 * Infers whether a contract looks like an upgradeable contract, based on any of the following:
 * - Inherits `Initializable` or `UUPSUpgradeable`.
 * - Has an `_authorizeUpgrade(address)` function.
 * - Has the NatSpec annotation `@custom:oz-upgrades`
 * - Has the NatSpec annotation `@custom:oz-upgrades-from <reference>`
 */
function inferUpgradeable(cursor: cursor.Cursor, contractDef: ContractDefinition): boolean {
	const hasInitializable = contractDef.inheritance?.types.items.some(type => type.typeName.items.some(item => item.text === "Initializable"));
	const hasUUPSUpgradeable = contractDef.inheritance?.types.items.some(type => type.typeName.items.some(item => item.text === "UUPSUpgradeable"));
	if (hasInitializable || hasUUPSUpgradeable) {
		return true;
	}

	const functionCursor = cursor.spawn();
	while (functionCursor.goToNextNonterminalWithKind(NonterminalKind.FunctionDefinition)) {
		const functionDefNode = functionCursor.node();
		assert(functionDefNode instanceof NonterminalNode);

		const functionDef = new FunctionDefinition(functionDefNode);
		const functionName = functionDef.name.variant.text;
		if (functionName === "_authorizeUpgrade" && functionDef.parameters.parameters.items.length === 1 && functionDef.parameters.parameters.items[0].typeName.cst.unparse() === "address") {
			return true;
		}
	}

	const natSpecTokens = getNatSpec(cursor)?.text.split(/\s+/);
	if (natSpecTokens !== undefined && (natSpecTokens.includes("@custom:oz-upgrades") || natSpecTokens.includes("@custom:oz-upgrades-from"))) {
		return true;
	}
	
	return false;
}

function validateNamespaceableContract(cursor: cursor.Cursor, diagnostics: Diagnostic[], textDocument: TextDocument, namespaceableContract: NamespaceableContract) {
	if (namespaceableContract.variables.length > 0) {
		const contractChildCursor = cursor.spawn();
		contractChildCursor.goToNextTerminalWithKind(TerminalKind.Identifier);

		const identifierStart = contractChildCursor.textRange.start;
		const contractDefEnd = cursor.textRange.end;

		addDiagnostic(
			diagnostics,
			textDocument,
			slangToVSCodeRange(textDocument, { start: identifierStart, end: contractDefEnd }),
			`Contract can be namespaced.`,
			"If this contract is an upgradeable contract, consider moving its variables to namespaced storage.",
			DiagnosticSeverity.Hint,
			CONTRACT_CAN_BE_NAMESPACED,
			namespaceableContract
		);
	}
}

async function validateNamespaceableVariables(cursor: cursor.Cursor, textDocument: TextDocument, diagnostics: Diagnostic[], namespaceableContract: NamespaceableContract, skipDiagnostic: boolean) {
	const childCursor = cursor.spawn();
	while (childCursor.goToNextNonterminalWithKind(NonterminalKind.StateVariableDefinition)) {
		const cursorNode = childCursor.node();
		assert(cursorNode instanceof NonterminalNode);

		const trimmedRange = getTrimmedRange(childCursor);
		const variableText = cursorNode.unparse().trim();

		// ignore immutable or constant variables
		let ignoreVariable = false;
		const language = new Language(await getSolidityVersion(textDocument));
		const parseVar = language.parse(NonterminalKind.StateVariableDefinition, variableText);
		const stateVar = new StateVariableDefinition(parseVar.tree() as NonterminalNode);
		const attributes = stateVar.attributes.items;

		let replacement = variableText;

		for (const attribute of attributes) {
			if (attribute.variant instanceof TerminalNode && (attribute.variant.kind === TerminalKind.ImmutableKeyword || attribute.variant.kind === TerminalKind.ConstantKeyword)) {
				ignoreVariable = true;
			} else {
				// If there is any attribute at all, recreate the variable without any attributes
				replacement = `${stateVar.typeName.cst.unparse()} ${stateVar.name.text};`;
				console.log("Replacing variable with: " + replacement);

				// TODO If a variable was originally public, make the quick fix add a public getter with the same signature to allow getting that variable from the namespace
			}
		}

		if (ignoreVariable) {
			console.log('Ignoring immutable or constant variable: ' + variableText);
		} else if (stateVar.value !== undefined) {
			if (!skipDiagnostic) {
				addDiagnostic(
					diagnostics,
					textDocument,
					slangToVSCodeRange(textDocument, trimmedRange),
					`Variable has initial value`,
					"If this contract is an upgradeable contract, consider moving this variable to namespaced storage and setting it in an initializer.",
					DiagnosticSeverity.Warning,
					VARIABLE_HAS_INITIAL_VALUE,
					undefined
				);
			}
		} else {
			if (!skipDiagnostic) {
				addDiagnostic(
					diagnostics,
					textDocument,
					slangToVSCodeRange(textDocument, trimmedRange),
					`Variable can be namespaced.`,
					"If this contract is an upgradeable contract, consider moving this variable to namespaced storage.",
					DiagnosticSeverity.Information,
					VARIABLE_CAN_BE_NAMESPACED,
					undefined
				);	
			}

			namespaceableContract.variables.push({ content: replacement, name: stateVar.name.text, range: slangToVSCodeRange(textDocument, trimmedRange) });
		}
	}
}

async function validateNamespaceCommentAndHash(cursor: cursor.Cursor, textDocument: TextDocument, contractDef: ContractDefinition, diagnostics: Diagnostic[]) {
	const spawnedCursor = cursor.spawn();
	while (spawnedCursor.goToNextNonterminalWithKind(NonterminalKind.StateVariableDefinition)) {
		const comment = getLastPrecedingTriviaWithKinds(spawnedCursor, [TerminalKind.SingleLineComment, TerminalKind.MultiLineComment]);
		let expectedHashFromComment = undefined;
		let commentHasUnexpectedNamespace = false;

		if (comment !== undefined) {
			// check if comment looks like a representation of the namespace hash calculation, and capture its namespace id
			const regex = /keccak256\(abi\.encode\(uint256\(keccak256\("(.*)"\)\) *- *1\)\) *& *~bytes32\(uint256\(0xff\)\)/;
			const match = comment.text.match(regex);

			if (match) {
				let namespacePrefix = await getNamespacePrefix(textDocument);

				// TODO to validate this hash, get expected namespace ID from struct annotation instead of based on contract name
				const expectedNamespaceId = getExpectedNamespaceId(namespacePrefix, contractDef);

				// namespace id in comment does not match expected namespace id
				assert(match[1] !== undefined);
				if (match[1] !== expectedNamespaceId) {
					commentHasUnexpectedNamespace = true;

					addDiagnostic(
						diagnostics,
						textDocument,
						slangToVSCodeRange(textDocument, comment.textRange),
						`Unexpected namespace id`,
						`Namespace id expected to be ${namespacePrefix}.${contractDef.name.text}`,
						DiagnosticSeverity.Warning,
						NAMESPACE_ID_MISMATCH_HASH_COMMENT,
						{ replacement: `// keccak256(abi.encode(uint256(keccak256("${expectedNamespaceId}")) - 1)) & ~bytes32(uint256(0xff))` } // TODO use comment or multiline commend depending on original kind. keep any other comment text that was there
					);
				}

				expectedHashFromComment = calculateERC7201StorageLocation(match[1]);
			}
		}

		const stateVarDefNode = spawnedCursor.node();
		assert(stateVarDefNode instanceof NonterminalNode);
		const stateVariableDefinition = new StateVariableDefinition(stateVarDefNode);
		if (stateVariableDefinition.name.text.match(/_STORAGE_LOCATION$/) || stateVariableDefinition.name.text.match(/StorageLocation$/)) {
			spawnedCursor.goToNextNonterminalWithKind(NonterminalKind.StateVariableDefinitionValue);
			spawnedCursor.goToNextNonterminalWithKind(NonterminalKind.Expression);
			const constantNode = spawnedCursor.node();
			if (constantNode instanceof NonterminalNode) {
				const text = constantNode.unparse();

				const expectedNamespaceId = getExpectedNamespaceId(await getNamespacePrefix(textDocument), contractDef);
				const expectedHashFromNamespace = calculateERC7201StorageLocation(expectedNamespaceId);

				if (expectedHashFromComment !== undefined && !text.includes(expectedHashFromComment)) {
					addDiagnostic(
						diagnostics,
						textDocument,
						slangToVSCodeRange(textDocument, getTrimmedRange(spawnedCursor)),
						`ERC7201 storage location hash does not match comment`,
						`Hash does not match formula in comment`,
						DiagnosticSeverity.Warning,
						NAMESPACE_HASH_MISMATCH,
						{ replacement: expectedHashFromComment }
					);
				}

				if (!commentHasUnexpectedNamespace && expectedHashFromNamespace !== expectedHashFromComment && !text.includes(expectedHashFromNamespace)) {
					addDiagnostic(
						diagnostics,
						textDocument,
						slangToVSCodeRange(textDocument, getTrimmedRange(spawnedCursor)),
						`ERC7201 storage location hash does not match expected namespace id`,
						`Expected hash to be based on ${expectedNamespaceId}`,
						DiagnosticSeverity.Warning,
						NAMESPACE_STANDALONE_HASH_MISMATCH,
						{ replacement: expectedHashFromNamespace }
					);
				}
			}
		}
	}

}

async function validateNamespaceStructAnnotation(cursor: cursor.Cursor, textDocument: TextDocument, contractDef: ContractDefinition, diagnostics: Diagnostic[]) {
	const structCursor = cursor.spawn();
	while (structCursor.goToNextNonterminalWithKind(NonterminalKind.StructDefinition)) {
		const structDefNode = structCursor.node();
		assert(structDefNode instanceof NonterminalNode);

		const natSpec = getNatSpec(structCursor);
		if (natSpec !== undefined) {
			let regex: RegExp;
			assert(natSpec.kind === TerminalKind.SingleLineNatSpecComment || natSpec.kind === TerminalKind.MultiLineNatSpecComment);

			if (natSpec.kind === TerminalKind.SingleLineNatSpecComment) {
				regex = /@custom:storage-location erc7201:(\S+)/;
			} else {
				regex = /@custom:storage-location erc7201:(\S+)(?=\s|\*\/)/;
			}

			const match = natSpec.text.match(regex);
			if (match && match[1] !== undefined) {
				console.log("Found erc7201 storage location annotation with id: " + match[1]);

				let namespacePrefix = await getNamespacePrefix(textDocument);
					const expectedNamespaceId = getExpectedNamespaceId(namespacePrefix, contractDef);
				if (match[1] !== expectedNamespaceId) {
					addDiagnostic(
						diagnostics,
						textDocument,
						slangToVSCodeRange(textDocument, natSpec.textRange),
						`Unexpected namespace id`,
						`Namespace id expected to be ${namespacePrefix}.${contractDef.name.text}`,
						DiagnosticSeverity.Warning,
						NAMESPACE_ID_MISMATCH,
						{ replacement: `/// @custom:storage-location erc7201:${expectedNamespaceId}` } // TODO use the same kind of NatSpec (single line or multiline) as the original, and keep any other text that was there
					);
				}
			}
		}

	}

	// TODO
	// - if there are multiple namespaces, show a warning
	// - if there are multiple namespaces with the same id, show an error

}
