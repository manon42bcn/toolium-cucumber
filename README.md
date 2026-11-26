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

## Diagnose missing steps

In a trusted workspace, the extension checks the steps in an open feature
against its suite. It expands each populated Scenario Outline using its Examples
rows and reports missing columns referenced by the step text, tables, or doc
strings. When static discovery detects unsupported Python definitions or imports,
it reports incomplete validation and suppresses undefined-step warnings.

For an undefined step, choose **Create Python step definition** from the Quick
Fix menu. The action creates a new module in the suite's `steps` directory
without overwriting existing files. If several example values are unresolved,
choose the value to scaffold.

## Navigate Toolium resources

In a `.feature` or Python file, place the cursor inside a resource placeholder.
Choose **Open resource** in the hover or run **Toolium Cucumber: Open Resource**
from the Command Palette or editor context menu. A single match opens directly.
When several equally specific destinations match, choose a file and line.

| Reference | Destination |
| --- | --- |
| `[LANG:observatory.status::en]` | A YAML mapping key or its explicit language. |
| `[CONF:observatory.lenses.0.name]` | An included JSON property or array entry. |
| `[POE:sky:chart.title]` | A matching identifier in a POEditor JSON array. |
| `[FILE:charts/list.txt]`, `[FILE_UTF8:charts/list.txt]`, `[BASE64:charts/image.png]` | An exact file under its configured base directory. |
| `[TOOLIUM:Observatory_mode]` | An explicit option in `toolium.cfg` or `local-toolium.cfg`. |

Type `:` or `.` in a bracketed LANG or CONF placeholder to complete its current
segment. Use `::` to select an explicit LANG language. LANG and CONF navigation
can open the deepest existing parent when a segment is dynamic or missing.
Use **Find All References** on YAML language keys, eligible CONF keys, POEditor
identifiers, and explicit TOOLIUM sections or options to find their usages in
Python and features. These operations read current editor contents, including
unsaved resource changes, and work independently of the Python step index.

Resource settings use the `tooliumCucumber.resources.` prefix and are scoped to
the workspace folder containing the source or resource. Configure
`resourcePaths`, `configurationPaths`, `poeditorPaths`, and `tooliumPaths` to
override the resource directories. Configure `filePath` and `base64Path` for
direct files, and `referencePaths` for reverse searches. Defaults use the
`acceptance/resources`, `acceptance/settings`, `acceptance/common`, and
`acceptance/features` conventions. An empty directory list disables its search.
An empty path selects the workspace root. Private CONF filenames are excluded
by default via `configurationExcludePatterns`. Use `poeditorSearchType`,
`poeditorKeyField`, and `poeditorPrefixes` to configure POEditor matching.

## Development

Run `npm ci` to install dependencies and `npm test` to build and run the tests.
Press F5 in VS Code to launch an Extension Development Host and try the
`test/fixtures/observatory.feature` example.

Run `npm run test:vscode` to verify Python completion, feature diagnostics, quick
fixes, and resource navigation in an isolated VS Code instance. The runner uses
`code` on PATH by default. Set `VSCODE_EXECUTABLE` to the VS Code CLI path if needed.
