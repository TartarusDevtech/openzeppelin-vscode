import {
	Range,
	TextDocument
} from 'vscode-languageserver-textdocument';
import { NonterminalKind, TerminalKind } from "@nomicfoundation/slang/kinds";
import assert = require('node:assert');
import { Node, NodeType, NonterminalNode, TerminalNode } from '@nomicfoundation/slang/cst';
import { cursor, text_index } from '@nomicfoundation/slang';
import { Language } from '@nomicfoundation/slang/language';
import { Query } from '@nomicfoundation/slang/query';
import semver from 'semver';

/**
 * Returns true if the node is a trivia terminal (whitespace or comment or NatSpec)
 */
export function isTrivia(node: Node) {
	return node instanceof TerminalNode &&
		(node.kind === TerminalKind.EndOfLine ||
			node.kind === TerminalKind.MultiLineComment ||
			node.kind === TerminalKind.MultiLineNatSpecComment ||
			node.kind === TerminalKind.SingleLineComment ||
			node.kind === TerminalKind.SingleLineNatSpecComment ||
			node.kind === TerminalKind.Whitespace);
}

/**
 * Moves the cursor to the last terminal node
 * @param cursor the cursor to move
 */
function goToLastTerminal(cursor: cursor.Cursor) {
	do {
		if (!cursor.clone().goToNextTerminal()) {
			break;
		}
	} while (cursor.goToNextTerminal());
}

/**
 * Gets the NatSpec comment within the leading trivia nodes starting from the cursor
 */
export function getNatSpec(cursor: cursor.Cursor) {
	const triviaCursor = cursor.clone();
	let natSpec = undefined;

	// Traverse terminal nodes from the cursor's position until we find a NatSpec comment, or reach a non-trivia node
	while (triviaCursor.goToNextTerminal()) {
		const node = triviaCursor.node();
		assert(node instanceof TerminalNode);
		if (!isTrivia(node)) {
			break;
		} else if (node.kind === TerminalKind.SingleLineNatSpecComment || node.kind === TerminalKind.MultiLineNatSpecComment) {
			natSpec = node.text;
			break;
		}
	}
	return natSpec;
}

export function goToPreviousTerminalWithKinds(cursor: cursor.Cursor, kinds: TerminalKind[]) {
	while (cursor.goToPrevious()) {
		const node = cursor.node();
		if (node.type === NodeType.Terminal && kinds.includes(node.kind)) {
			return true;
		}
	}
	return false;
}

/**
 * Gets the range of the cursor, trimming whitespace, comments, and NatSpec from the start and end
 * @param cursor the cursor to get the original range from
 * @returns the trimmed range
 */
export function getTrimmedRange(cursor: cursor.Cursor) {
	const childCursor = cursor.spawn();

	let start = childCursor.textRange.start;
	let end = childCursor.textRange.end;

	const childNode = childCursor.node();
	assert(childNode instanceof NonterminalNode);

	// find the first non-trivia terminal
	while (childCursor.goToNextTerminal() && isTrivia(childCursor.node())) {
	}
	start = childCursor.textRange.start;

	// move to the last terminal
	goToLastTerminal(childCursor);

	// move back until we find a non-whitespace terminal
	while (childCursor.goToPrevious()) {
		if (childCursor.node().type === NodeType.Terminal && !isTrivia(childCursor.node())) {
			end = childCursor.textRange.end;
			break;
		}
	}

	return { start, end };
}

// from https://github.com/NomicFoundation/hardhat-vscode/blob/8190465cf6a98b8a500393e36c4daa967495bc3b/server/src/parser/slangHelpers.ts#L24
export function slangToVSCodeRange(doc: TextDocument, slangRange: text_index.TextRange): Range {
	return {
		start: doc.positionAt(slangRange.start.utf16),
		end: doc.positionAt(slangRange.end.utf16)
	};
}

export function getHighestSupportedPragmaVersion(textDocument: TextDocument) {
	const allSolidityVersions = Language.supportedVersions();

	const language = new Language(allSolidityVersions[allSolidityVersions.length - 1]);
	const parseOutput = language.parse(NonterminalKind.SourceUnit, textDocument.getText());

	const cursor = parseOutput.createTreeCursor();

	const query = Query.parse("@versionExpressionSet [VersionExpressionSet]");
	const matches = cursor.query([query]);

	const possibleHighestVersions: string[] = [];

	let match;
	while ((match = matches.next())) {
		const captures = match.captures;
		const cursors = captures["versionExpressionSet"];
	
		const cursor = cursors?.[0]?.node() as NonterminalNode;

		// for each set, iterate through the versionExpressions
		const versionExpressions = cursor.children();
		for (const versionExpression of versionExpressions) {
			assert(versionExpression instanceof NonterminalNode);
			const version = versionExpression.unparse().trim();

			const maxSatisfying = semver.maxSatisfying(allSolidityVersions, version);
			if (maxSatisfying !== null) {
				possibleHighestVersions.push(maxSatisfying);
			} else {
				console.error('Could not find max satisfying version for range:' + version);
			}
		}
	}

	return semver.maxSatisfying(possibleHighestVersions, '*');
}