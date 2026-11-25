# Toolium Cucumber

A VS Code extension for editing `.feature` files in Toolium projects.

The extension highlights Gherkin syntax and supports line comments, section folding,
and navigation in the Outline view. Syntax validation uses the dialect specified
by `# language` and defaults to English.

Hover over a section heading to see its effective tags and where they were
declared. Run **Toolium Cucumber: Find by Tag in This Feature** to jump to a
section with a matching declared or inherited tag. The extension marks tags with
placeholders, such as `@record:<figure>`, as errors on regular scenarios.

## Navigate to a Python step

Place the cursor on a step and run **Toolium Cucumber: Go to Step Definition**
from the Command Palette. This works in scenarios, backgrounds, Toolium action
blocks such as `Actions Before the Feature:`, and literal Python strings
passed to `execute_steps`. If a shared Python caller is imported by multiple
suites, choose the suite first. If multiple Python functions match, choose a
destination from the list.

Python navigation supports single-line and multiline literals. Strings assembled
at runtime, f-strings, and concatenated literals are outside the current scope.

The index starts at the nearest `steps` directory above the feature. It reads
the suite's direct step files and `environment.py`, then follows static imports
to shared source and to Toolium packages available in the selected interpreter.
It recognizes literal `given`, `when`, `then`, and `step` patterns, including
common built-in `parse` field types. Exact texts are indexed by decorator, with
parameterized patterns compiled for reuse. Imported modules are read as source.
Dynamic registration, custom converters, and other matchers are outside this
initial implementation.

Navigation requires a trusted file-based workspace and Python 3.9 or later.
The extension looks for a nearby `.venv` and then uses Python on PATH. Set
`tooliumCucumber.pythonInterpreter` to select a different interpreter.
Use `tooliumCucumber.stepImportPaths` for extra source roots, such as an editable
package whose location is configured by a Python startup hook.

## Complete and inspect steps

Type a step keyword and a space, or invoke **Trigger Suggest** from the Command
Palette. The suggestions use the definitions loaded for the current suite. Use
Tab to move through the inserted parameter fields. Hover over a resolved step
to see its Python function, pattern, source location, and docstring when
available.

In Python, completion also works on lines inside a multiline literal passed to
`execute_steps`. Use **Trigger Suggest** if suggestions do not open while typing
inside the string. Shared Python modules receive suggestions from the suites
that import them.

## Development

Run `npm ci` to install dependencies and `npm test` to build and run the tests.
Press F5 in VS Code to launch an Extension Development Host and try the
`test/fixtures/observatory.feature` example.

Run `npm run test:vscode` to verify Python completion in an isolated VS Code
instance. The runner uses `code` on PATH by default. Set `VSCODE_EXECUTABLE` to
the VS Code CLI path if needed.
