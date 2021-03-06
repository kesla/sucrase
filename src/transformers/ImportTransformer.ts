import ImportProcessor from "../ImportProcessor";
import {RootTransformer} from "../index";
import NameManager from "../NameManager";
import TokenProcessor, {Token} from "../TokenProcessor";
import isMaybePropertyName from "../util/isMaybePropertyName";
import Transformer from "./Transformer";

export default class ImportTransformer implements Transformer {
  private hadExport: boolean = false;
  private hadNamedExport: boolean = false;
  private hadDefaultExport: boolean = false;

  constructor(
    readonly rootTransformer: RootTransformer,
    readonly tokens: TokenProcessor,
    readonly nameManager: NameManager,
    readonly importProcessor: ImportProcessor,
    readonly shouldAddModuleExports: boolean,
  ) {}

  preprocess(): void {
    this.nameManager.preprocessNames(this.tokens.tokens);
    this.importProcessor.preprocessTokens();
  }

  getPrefixCode(): string {
    let prefix = "'use strict';";
    prefix += this.importProcessor.getPrefixCode();
    if (this.hadExport) {
      prefix += 'Object.defineProperty(exports, "__esModule", {value: true});';
    }
    return prefix;
  }

  getSuffixCode(): string {
    if (this.shouldAddModuleExports && this.hadDefaultExport && !this.hadNamedExport) {
      return "\nmodule.exports = exports.default;\n";
    }
    return "";
  }

  process(): boolean {
    if (
      this.tokens.matches(["import"]) &&
      !isMaybePropertyName(this.tokens, this.tokens.currentIndex())
    ) {
      this.processImport();
      return true;
    }
    if (
      this.tokens.matches(["export"]) &&
      !isMaybePropertyName(this.tokens, this.tokens.currentIndex())
    ) {
      this.hadExport = true;
      this.processExport();
      return true;
    }
    if (this.tokens.matches(["name"]) || this.tokens.matches(["jsxName"])) {
      return this.processIdentifier();
    }
    if (this.tokens.matches(["="])) {
      return this.processAssignment();
    }
    return false;
  }

  /**
   * Transform this:
   * import foo, {bar} from 'baz';
   * into
   * var _baz = require('baz'); var _baz2 = _interopRequireDefault(_baz);
   *
   * The import code was already generated in the import preprocessing step, so
   * we just need to look it up.
   */
  private processImport(): void {
    this.tokens.removeInitialToken();
    while (!this.tokens.matches(["string"])) {
      this.tokens.removeToken();
    }
    const path = this.tokens.currentToken().value;
    this.tokens.replaceTokenTrimmingLeftWhitespace(this.importProcessor.claimImportCode(path));
    if (this.tokens.matches([";"])) {
      this.tokens.removeToken();
    }
  }

  private processIdentifier(): boolean {
    const token = this.tokens.currentToken();
    const lastToken = this.tokens.tokens[this.tokens.currentIndex() - 1];
    const nextToken = this.tokens.tokens[this.tokens.currentIndex() + 1];
    // Skip identifiers that are part of property accesses.
    if (lastToken && lastToken.type.label === ".") {
      return false;
    }

    // For shorthand object keys, we need to expand them and replace only the value.
    if (
      token.contextName === "object" &&
      lastToken &&
      (lastToken.type.label === "," || lastToken.type.label === "{") &&
      nextToken &&
      (nextToken.type.label === "," || nextToken.type.label === "}")
    ) {
      return this.processObjectShorthand();
    }

    // For non-shorthand object keys, just ignore them.
    if (
      token.contextName === "object" &&
      nextToken &&
      nextToken.type.label === ":" &&
      lastToken &&
      (lastToken.type.label === "," || lastToken.type.label === "{")
    ) {
      return false;
    }

    // Object methods identifiers can be identified similarly, and they also
    // could have the async keyword before them.
    if (
      token.contextName === "object" &&
      nextToken &&
      nextToken.type.label === "(" &&
      lastToken &&
      (lastToken.type.label === "," ||
        lastToken.type.label === "{" ||
        (lastToken.type.label === "name" && lastToken.value === "async"))
    ) {
      return false;
    }

    // Identifiers within class bodies must be method names.
    if (token.contextName === "class") {
      return false;
    }
    const replacement = this.importProcessor.getIdentifierReplacement(token.value);
    if (!replacement) {
      return false;
    }
    // For now, always use the (0, a) syntax so that non-expression replacements
    // are more likely to become syntax errors.
    this.tokens.replaceToken(`(0, ${replacement})`);
    return true;
  }

  processObjectShorthand(): boolean {
    const identifier = this.tokens.currentToken().value;
    const replacement = this.importProcessor.getIdentifierReplacement(identifier);
    if (!replacement) {
      return false;
    }
    this.tokens.replaceToken(`${identifier}: ${replacement}`);
    return true;
  }

  processExport(): void {
    if (this.tokens.matches(["export", "default"])) {
      this.processExportDefault();
      this.hadDefaultExport = true;
      return;
    }
    this.hadNamedExport = true;
    if (
      this.tokens.matches(["export", "var"]) ||
      this.tokens.matches(["export", "let"]) ||
      this.tokens.matches(["export", "const"])
    ) {
      this.processExportVar();
    } else if (
      this.tokens.matches(["export", "function"]) ||
      this.tokens.matches(["export", "name", "function"])
    ) {
      this.processExportFunction();
    } else if (this.tokens.matches(["export", "class"])) {
      this.processExportClass();
    } else if (this.tokens.matches(["export", "{"])) {
      this.processExportBindings();
    } else if (this.tokens.matches(["export", "*"])) {
      this.processExportStar();
    } else {
      throw new Error("Unrecognized export syntax.");
    }
  }

  private processAssignment(): boolean {
    const index = this.tokens.currentIndex();
    const identifierToken = this.tokens.tokens[index - 1];
    if (identifierToken.type.label !== "name") {
      return false;
    }
    if (this.tokens.matchesAtIndex(index - 2, ["."])) {
      return false;
    }
    if (
      index - 2 >= 0 &&
      ["var", "let", "const"].includes(this.tokens.tokens[index - 2].type.label)
    ) {
      // Declarations don't need an extra assignment. This doesn't avoid the
      // assignment for comma-separated declarations, but it's still correct
      // since the assignment is just redundant.
      return false;
    }
    const exportedName = this.importProcessor.resolveExportBinding(identifierToken.value);
    if (!exportedName) {
      return false;
    }
    this.tokens.copyToken();
    this.tokens.appendCode(` exports.${exportedName} =`);
    return true;
  }

  private processExportDefault(): void {
    if (
      this.tokens.matches(["export", "default", "function", "name"]) ||
      this.tokens.matches(["export", "default", "name", "function", "name"])
    ) {
      this.tokens.removeInitialToken();
      this.tokens.removeToken();
      // Named function export case: change it to a top-level function
      // declaration followed by exports statement.
      const name = this.processNamedFunction();
      this.tokens.appendCode(` exports.default = ${name};`);
    } else if (this.tokens.matches(["export", "default", "class", "name"])) {
      this.tokens.removeInitialToken();
      this.tokens.removeToken();
      const name = this.processNamedClass();
      this.tokens.appendCode(` exports.default = ${name};`);
    } else {
      this.tokens.replaceToken("exports.");
      this.tokens.copyToken();
      this.tokens.appendCode(" =");
    }
  }

  /**
   * Transform this:
   * export const x = 1;
   * into this:
   * const x = exports.x = 1;
   */
  private processExportVar(): void {
    this.tokens.replaceToken("");
    this.tokens.copyToken();
    if (!this.tokens.matches(["name"])) {
      throw new Error("Expected a regular identifier after export var/let/const.");
    }
    const name = this.tokens.currentToken().value;
    this.tokens.copyToken();
    this.tokens.appendCode(` = exports.${name}`);
  }

  /**
   * Transform this:
   * export function foo() {}
   * into this:
   * function foo() {} exports.foo = foo;
   */
  private processExportFunction(): void {
    this.tokens.replaceToken("");
    const name = this.processNamedFunction();
    this.tokens.appendCode(` exports.${name} = ${name};`);
  }

  /**
   * Skip past a function with a name and return that name.
   */
  private processNamedFunction(): string {
    if (this.tokens.matches(["function"])) {
      this.tokens.copyToken();
    } else if (this.tokens.matches(["name", "function"])) {
      if (this.tokens.currentToken().value !== "async") {
        throw new Error("Expected async keyword in function export.");
      }
      this.tokens.copyToken();
      this.tokens.copyToken();
    }
    if (!this.tokens.matches(["name"])) {
      throw new Error("Expected identifier for exported function name.");
    }
    const name = this.tokens.currentToken().value;
    this.tokens.copyToken();
    this.tokens.copyExpectedToken("(");
    this.rootTransformer.processBalancedCode();
    this.tokens.copyExpectedToken(")");
    this.tokens.copyExpectedToken("{");
    this.rootTransformer.processBalancedCode();
    this.tokens.copyExpectedToken("}");
    return name;
  }

  /**
   * Transform this:
   * export class A {}
   * into this:
   * class A {} exports.A = A;
   */
  private processExportClass(): void {
    this.tokens.replaceToken("");
    const name = this.processNamedClass();
    this.tokens.appendCode(` exports.${name} = ${name};`);
  }

  /**
   * Skip past a class with a name and return that name.
   */
  private processNamedClass(): string {
    this.tokens.copyExpectedToken("class");
    if (!this.tokens.matches(["name"])) {
      throw new Error("Expected identifier for exported class name.");
    }
    const name = this.tokens.currentToken().value;
    this.tokens.copyToken();
    if (this.tokens.matches(["extends"])) {
      // There are only some limited expressions that are allowed within the
      // `extends` expression, e.g. no top-level binary operators, so we can
      // skip past even fairly complex expressions by being a bit careful.
      this.tokens.copyToken();
      if (this.tokens.matches(["{"])) {
        // Extending an object literal.
        this.tokens.copyExpectedToken("{");
        this.rootTransformer.processBalancedCode();
        this.tokens.copyExpectedToken("}");
      } else {
        while (!this.tokens.matches(["{"]) && !this.tokens.matches(["("])) {
          this.rootTransformer.processToken();
        }
        if (this.tokens.matches(["("])) {
          this.tokens.copyExpectedToken("(");
          this.rootTransformer.processBalancedCode();
          this.tokens.copyExpectedToken(")");
        }
      }
    }

    this.tokens.copyExpectedToken("{");
    this.rootTransformer.processBalancedCode();
    this.tokens.copyExpectedToken("}");
    return name;
  }

  /**
   * Transform this:
   * export {a, b as c};
   * into this:
   * exports.a = a; exports.c = b;
   *
   * OR
   *
   * Transform this:
   * export {a, b as c} from './foo';
   * into the pre-generated Object.defineProperty code from the ImportProcessor.
   */
  private processExportBindings(): void {
    this.tokens.removeInitialToken();
    this.tokens.removeToken();

    const exportStatements = [];
    while (true) {
      const localName = this.tokens.currentToken().value;
      let exportedName;
      this.tokens.removeToken();
      if (this.tokens.matchesName("as")) {
        this.tokens.removeToken();
        exportedName = this.tokens.currentToken().value;
        this.tokens.removeToken();
      } else {
        exportedName = localName;
      }
      exportStatements.push(`exports.${exportedName} = ${localName};`);

      if (this.tokens.matches(["}"])) {
        this.tokens.removeToken();
        break;
      }
      if (this.tokens.matches([",", "}"])) {
        this.tokens.removeToken();
        this.tokens.removeToken();
        break;
      } else if (this.tokens.matches([","])) {
        this.tokens.removeToken();
      } else {
        throw new Error("Unexpected token");
      }
    }

    if (this.tokens.matchesName("from")) {
      // This is an export...from, so throw away the normal named export code
      // and use the Object.defineProperty code from ImportProcessor.
      this.tokens.removeToken();
      const path = this.tokens.currentToken().value;
      this.tokens.replaceTokenTrimmingLeftWhitespace(this.importProcessor.claimImportCode(path));
    } else {
      // This is a normal named export, so use that.
      this.tokens.appendCode(exportStatements.join(" "));
    }

    if (this.tokens.matches([";"])) {
      this.tokens.removeToken();
    }
  }

  private processExportStar(): void {
    this.tokens.removeInitialToken();
    while (!this.tokens.matches(["string"])) {
      this.tokens.removeToken();
    }
    const path = this.tokens.currentToken().value;
    this.tokens.replaceTokenTrimmingLeftWhitespace(this.importProcessor.claimImportCode(path));
    if (this.tokens.matches([";"])) {
      this.tokens.removeToken();
    }
  }
}
