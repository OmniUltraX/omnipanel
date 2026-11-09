import { describe, it, expect } from "vitest";
import { splitSqlStatements } from "../../sqlIntel/sqlLex";

/**
 * Test helper to simulate statementAtCursor logic.
 * This is a simplified version for testing the blank line detection.
 */
function findStatementAtPosition(text: string, head: number) {
  const parts = splitSqlStatements(text);
  
  // First check if cursor is inside a statement
  for (let i = 0; i < parts.length; i += 1) {
    const stmt = parts[i];
    if (head >= stmt.from && head < stmt.to) {
      return stmt;
    }
  }
  
  // Check if cursor is on a blank line
  const lineStart = text.lastIndexOf("\n", head - 1) + 1;
  const lineEnd = text.indexOf("\n", head);
  const currentLine = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const isBlankLine = /^\s*$/.test(currentLine);
  
  if (isBlankLine) {
    return null;
  }
  
  // Check if cursor is after semicolon with only whitespace
  for (let i = 0; i < parts.length; i += 1) {
    const stmt = parts[i];
    const nextFrom = i + 1 < parts.length ? parts[i + 1].from : text.length + 1;
    if (head < stmt.to || head >= nextFrom) continue;
    if (!/^[\s;]*$/.test(text.slice(stmt.to, head))) continue;
    return stmt;
  }
  
  return null;
}

describe("SQL Statement Frame - Blank Line Handling", () => {
  it("should not highlight when cursor is on blank line after semicolon", () => {
    const sql = `SELECT * FROM users;\n\n`;
    const cursorPos = sql.length - 1; // On the second blank line
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).toBeNull();
  });

  it("should not highlight when cursor is on blank line at EOF", () => {
    const sql = `SELECT * FROM users;\n`;
    const cursorPos = sql.length; // At EOF after newline
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).toBeNull();
  });

  it("should not highlight when cursor is on whitespace-only line", () => {
    const sql = `SELECT * FROM users;\n   \n`;
    const cursorPos = sql.indexOf("   ") + 1; // On whitespace-only line
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).toBeNull();
  });

  it("should highlight when cursor is inside SQL statement", () => {
    const sql = `SELECT * FROM users;`;
    const cursorPos = 10; // Inside "FROM"
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).not.toBeNull();
    expect(result?.sql).toContain("SELECT");
  });

  it("should highlight when cursor is on semicolon", () => {
    const sql = `SELECT * FROM users;`;
    const cursorPos = sql.indexOf(";"); // On semicolon
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).not.toBeNull();
    expect(result?.sql).toContain("SELECT");
  });

  it("should not highlight on blank line between statements", () => {
    const sql = `SELECT * FROM users;\n\nSELECT * FROM orders;`;
    const cursorPos = sql.indexOf(";\n") + 2; // On blank line between statements
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).toBeNull();
  });

  it("should highlight second statement when cursor is inside it", () => {
    const sql = `SELECT * FROM users;\n\nSELECT * FROM orders;`;
    const cursorPos = sql.lastIndexOf("SELECT") + 7; // Inside second SELECT
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).not.toBeNull();
    expect(result?.sql).toContain("orders");
  });

  it("should highlight when cursor is on line with semicolon but has content", () => {
    const sql = `SELECT * FROM users; -- comment`;
    const cursorPos = sql.indexOf(";") + 1; // After semicolon but on same line with comment
    
    const result = findStatementAtPosition(sql, cursorPos);
    // This should highlight because the line is not blank
    expect(result).not.toBeNull();
  });

  it("should highlight multiline statement even with blank line inside", () => {
    const sql = `SELECT\n\n  *\nFROM users;`;
    const cursorPos = sql.indexOf("\n\n") + 2; // On blank line inside SELECT statement
    
    const result = findStatementAtPosition(sql, cursorPos);
    // Blank line inside statement boundaries should be treated as part of statement
    // This is within the statement range (from=0, to=end), so it should highlight
    expect(result).not.toBeNull();
    expect(result?.sql).toContain("SELECT");
  });

  it("should not highlight multiple trailing blank lines", () => {
    const sql = `SELECT * FROM users;\n\n\n`;
    const positions = [
      sql.length - 2, // Second blank line
      sql.length - 1, // Third blank line
      sql.length,     // EOF
    ];
    
    for (const pos of positions) {
      const result = findStatementAtPosition(sql, pos);
      expect(result).toBeNull();
    }
  });

  it("should handle statement with only whitespace before it", () => {
    const sql = `\n\n  SELECT * FROM users;`;
    const cursorPos = 1; // On first blank line before statement
    
    const result = findStatementAtPosition(sql, cursorPos);
    expect(result).toBeNull();
  });
});
