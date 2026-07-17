import * as vscode from "vscode"

interface StackFrame {
  indent: number
  line: number
  lastBodyLine: number
  depth: number // nesting depth captured at push time, used for stable coloring
}

function getColors(): string[] {
  return vscode.workspace
    .getConfiguration("rainbowBraces")
    .get<
      string[]
    >("colors", ["#e06c75", "#61afef", "#98c379", "#c678dd", "#d19a66", "#56b6c2"])
}

function makeOpenDecoType(color: string) {
  return vscode.window.createTextEditorDecorationType({
    color: "transparent",
    after: {
      contentText: "{ ",
      color,
      fontWeight: "bold;",
    },
  })
}

function makeCloseDecoType(color: string) {
  return vscode.window.createTextEditorDecorationType({
    after: {
      contentText: "} ",
      color,
      fontWeight: "bold",
      textDecoration:
        "none; white-space: pre-wrap; display: inline-block;",
      // textDecoration: "none; white-space: pre-wrap; display: block;",
    },
  })
}

let openTypes: vscode.TextEditorDecorationType[] = []
let closeTypes: vscode.TextEditorDecorationType[] = []

const MAX_DEPTH = 64 // Handle up to 64 levels of nesting safely

function createDecorationTypes() {
  disposeDecorationTypes()
  const colors = getColors()
  const n = colors.length

  openTypes = colors.map((c) => makeOpenDecoType(c))

  // FIX 1: Generate closing decoration types for every depth level.
  // This allows us to control the exact stack order of the braces.
  closeTypes = Array.from({ length: MAX_DEPTH }, (_, i) =>
    makeCloseDecoType(colors[i % n]),
  )
}

function disposeDecorationTypes() {
  ;[...openTypes, ...closeTypes].forEach((d) => d.dispose())
  openTypes = []
  closeTypes = []
}

function stripTrailingComment(s: string): string {
  const idx = s.indexOf("#")
  return idx === -1 ? s : s.slice(0, idx).trim()
}

function updateDecorations(editor: vscode.TextEditor) {
  if (editor.document.languageId !== "python") return

  const doc = editor.document
  const lineCount = doc.lineCount
  const n = openTypes.length

  const openBuckets: vscode.DecorationOptions[][] = openTypes.map(
    () => [],
  )
  const closeBuckets: vscode.DecorationOptions[][] = closeTypes.map(
    () => [],
  )
  const stack: StackFrame[] = []

  for (let i = 0; i < lineCount; i++) {
    const line = doc.lineAt(i)
    const text = line.text
    const trimmed = text.trim()

    if (trimmed.length === 0 || trimmed.startsWith("#")) continue

    const indent = text.length - text.trimStart().length

    // pop any frames we've dedented out of (including sibling headers at
    // the same indent level), emitting a virtual '}' for each
    var lineUseCount = 0
    var lastUsedLine = 0
    while (
      stack.length > 0 &&
      indent <= stack[stack.length - 1].indent
    ) {
      const frame = stack.pop()!
      const colorIdx = frame.depth % n
      var l = frame.lastBodyLine + 1
      if (l == lastUsedLine) {
        l += ++lineUseCount
      } else {
        lineUseCount = 0
      }
      lastUsedLine = frame.lastBodyLine + 1
      const closeLine = doc.lineAt(l)

      // --- DYNAMIC SAME-LINE ALIGNMENT ---
      const closeLineText = closeLine.text
      const closeLineTrimmed = closeLineText.trim()
      const closeLineIndent =
        closeLineText.length - closeLineText.trimStart().length

      let pos: vscode.Position
      let marginStr: string

      // If there is actual code on this line, and its indentation matches the target block
      if (
        closeLineTrimmed.length > 0 &&
        closeLineIndent === frame.indent
      ) {
        // Place the decoration directly at the indentation column (e.g. after the spaces).
        // It will render immediately before the text, e.g. "    }else:"
        pos = new vscode.Position(l, frame.indent)
        marginStr = `0.1em 0 0 0ch`
      } else {
        // Otherwise, place it at the start of the line and push it with margins
        pos = closeLine.range.start
        marginStr = `0.1em 0 0 ${frame.indent}ch`
      }
      // ------------------------------------

      closeBuckets[colorIdx].push({
        range: new vscode.Range(pos, pos),
        renderOptions: {
          after: {
            margin: marginStr,
          },
        },
      })
    }

    for (const frame of stack) {
      frame.lastBodyLine = i
    }

    const codePart = stripTrailingComment(trimmed)
    if (codePart.endsWith(":")) {
      const depth = stack.length
      const colorIdx = depth % n
      const colonCol = text.lastIndexOf(":")

      openBuckets[colorIdx].push({
        range: new vscode.Range(
          new vscode.Position(i, colonCol),
          new vscode.Position(i, colonCol + 1),
        ),
      })

      stack.push({ indent, line: i, lastBodyLine: i, depth })
    }
  }

  // close anything still open at EOF
  lineUseCount = 0
  lastUsedLine = 0
  while (stack.length > 0) {
    const frame = stack.pop()!
    const colorIdx = frame.depth % n

    // Calculate the target empty line below the last body line
    let l = frame.lastBodyLine + 1
    if (l === lastUsedLine) {
      l += ++lineUseCount
    } else {
      lineUseCount = 0
    }
    lastUsedLine = frame.lastBodyLine + 1

    // Make sure we don't accidentally query past the end of the document
    const targetLineNum = Math.min(l, doc.lineCount - 1)
    const closeLine = doc.lineAt(targetLineNum)
    const pos = closeLine.range.end

    closeBuckets[colorIdx].push({
      range: new vscode.Range(pos, pos),
      renderOptions: {
        after: {
          margin: `0.1em 0 0 ${frame.indent}ch`,
        },
      },
    })
  }

  openTypes.forEach((type, idx) =>
    editor.setDecorations(type, openBuckets[idx]),
  )

  // Apply closing decorations in reverse order.
  for (let idx = closeTypes.length - 1; idx >= 0; idx--) {
    editor.setDecorations(closeTypes[idx], closeBuckets[idx])
  }
}

function updateAllVisibleEditors() {
  // Get all unique visible text editors currently open on screen
  const visibleEditors = vscode.window.visibleTextEditors

  for (const editor of visibleEditors) {
    if (editor.document.languageId === "python") {
      updateDecorations(editor)
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  createDecorationTypes()

  // Initial schedule for all currently visible editors
  updateAllVisibleEditors()

  context.subscriptions.push(
    // --- REGISTER THE FORMATTER ---
    vscode.languages.registerDocumentFormattingEditProvider(
      "python",
      {
        provideDocumentFormattingEdits(
          document: vscode.TextDocument,
        ): vscode.TextEdit[] {
          return providePythonFormattingEdits(document)
        },
      },
    ),
    // ------------------------------

    // Triggered when any editor's visible range changes (scrolling, resizing)
    vscode.window.onDidChangeTextEditorVisibleRanges(
      updateAllVisibleEditors,
    ),

    // Triggered when changing tabs
    vscode.window.onDidChangeActiveTextEditor(
      updateAllVisibleEditors,
    ),

    // Triggered when text changes in any open document
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Find visible editors displaying this document and update them
      const editorsToUpdate = vscode.window.visibleTextEditors.filter(
        (editor) => editor.document === e.document,
      )
      if (editorsToUpdate.length > 0) {
        updateAllVisibleEditors()
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rainbowBraces")) {
        createDecorationTypes()
        updateAllVisibleEditors()
      }
    }),
  )
}

function providePythonFormattingEdits(
  document: vscode.TextDocument,
): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = []
  const lineCount = document.lineCount
  const stack: { indent: number; lastBodyLine: number }[] = []

  for (let i = 0; i < lineCount; i++) {
    const line = document.lineAt(i)
    const text = line.text
    const trimmed = text.trim()

    if (trimmed.length === 0 || trimmed.startsWith("#")) continue

    const indent = text.length - text.trimStart().length

    // Detect when blocks close (dedenting)
    let popCount = 0
    let lastBodyLine = -1
    while (
      stack.length > 0 &&
      indent <= stack[stack.length - 1].indent
    ) {
      const frame = stack.pop()!
      popCount++
      lastBodyLine = frame.lastBodyLine
    }

    if (popCount > 0 && lastBodyLine !== -1) {
      const targetLineNum = lastBodyLine + 1
      if (targetLineNum < lineCount) {
        const nextLine = document.lineAt(targetLineNum)
        const nextLineTrimmed = nextLine.text.trim()

        // Do not add newlines if the next block is an immediate keyword continuation
        if (
          nextLineTrimmed !== "else:" &&
          !nextLineTrimmed.startsWith("elif ")
        ) {
          // Count ONLY contiguous empty lines right after lastBodyLine
          let existingEmptyLines = 0
          for (let j = lastBodyLine + 1; j < lineCount; j++) {
            if (document.lineAt(j).text.trim().length === 0) {
              existingEmptyLines++
            } else {
              break // Stop as soon as we hit any code or comments!
            }
          }

          const neededNewlines = popCount - existingEmptyLines
          if (neededNewlines > 0) {
            edits.push(
              vscode.TextEdit.insert(
                new vscode.Position(targetLineNum, 0),
                "\n".repeat(neededNewlines),
              ),
            )
          }
        }
      }
    }

    for (const frame of stack) {
      frame.lastBodyLine = i
    }

    const codePart = stripTrailingComment(trimmed)
    if (codePart.endsWith(":")) {
      stack.push({ indent, lastBodyLine: i })
    }
  }

  // Handle remaining blocks open at the end of the file
  let popCount = 0
  let lastBodyLine = -1
  while (stack.length > 0) {
    const frame = stack.pop()!
    popCount++
    lastBodyLine = frame.lastBodyLine
  }

  if (popCount > 0 && lastBodyLine !== -1) {
    const targetLineNum = lastBodyLine + 1
    if (targetLineNum < lineCount) {
      // Count ONLY contiguous empty lines right after lastBodyLine to EOF
      let existingEmptyLines = 0
      for (let j = lastBodyLine + 1; j < lineCount; j++) {
        if (document.lineAt(j).text.trim().length === 0) {
          existingEmptyLines++
        } else {
          break // Stop as soon as we hit any code or comments!
        }
      }

      const neededNewlines = popCount - existingEmptyLines
      if (neededNewlines > 0) {
        edits.push(
          vscode.TextEdit.insert(
            new vscode.Position(targetLineNum, 0),
            "\n".repeat(neededNewlines),
          ),
        )
      }
    }
  }

  return edits
}

export function deactivate() {
  disposeDecorationTypes()
}

// TODO add gdscript support
