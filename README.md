# Toolium Cucumber

A VS Code extension for editing `.feature` files in Toolium projects.

The extension highlights Gherkin syntax and supports line comments, section folding,
and navigation in the Outline view. Syntax validation uses the dialect specified
by `# language` and defaults to English.

Hover over a section heading to see its effective tags and where they were
declared. Run **Toolium Cucumber: Find by Tag in This Feature** to jump to a
section with a matching declared or inherited tag. The extension marks tags with
placeholders, such as `@record:<figure>`, as errors on regular scenarios.

The feature-level `@US.` tag is checked against concrete acceptance tags such
as `@jira.ac.ORBIT-12#AC1,AC2`. Use **Update feature @US tag** from the Quick Fix
menu to add missing story keys or create the summary. The action preserves
existing story keys and ignores keys that contain placeholders.

Run **Toolium Cucumber: Clean Feature @US Tag** from the Command Palette to
remove existing story keys that have no concrete acceptance tag in the feature.
The cleanup can be run independently and only removes entries. An empty
summary tag is removed.

## Find Jira bug references

Set `tooliumCucumber.jira.issuePrefixes` to the Jira project keys to search,
for example `["TOOLIUM"]`. The setting has no default prefixes. Run
**Toolium Cucumber: Find Jira Bug References** and enter a complete ID such as
`TOOLIUM-123`. The command searches `.feature` files in workspace folders
that allow that prefix, including unsaved edits in open files.

The command finds IDs in `@jira.link.detects` tags, including colon-separated
lists. For a tag such as `@jira.link.detects.TOOLIUM-42:<bug_id>`, it also
checks the `bug_id` column of applicable Examples rows. Each destination
opens at the literal tag ID or the corresponding Examples cell.

To open a Jira issue, set
`tooliumCucumber.jira.issueUrlTemplate` to an HTTP(S) URL such as
`https://jira.example.es/browse/(id)`. Run **Toolium Cucumber: Open Jira Issue**
from the editor context menu with the cursor on an issue ID or with the full
ID selected. You can also run it from the Command Palette and enter the ID at
the prompt. The URL template is empty by default.
Opening an issue only requires its full ID and the URL template. Prefixes
filter feature reference searches.

The command uses the system browser by default. Set
`tooliumCucumber.jira.openInIntegratedBrowser` to `true` in your VS Code user
settings to open the issue in an integrated browser tab beside the active editor. If the
integrated browser is unavailable, the command uses the system browser.

To view the same issue inside VS Code Desktop, run **Browser: Open Integrated
Browser** and paste the full issue URL into the address bar. This manual flow
uses a built-in VS Code feature and requires no additional Toolium Cucumber
setting. You may need to sign in to Jira in the integrated browser.
[VS Code integrated browser documentation](https://code.visualstudio.com/docs/debugtest/integrated-browser#open-the-browser)

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
common built-in `parse` field types and Toolium Telefónica's generic step
wrappers, including aliased catalog decorators. Exact texts are indexed by decorator, with
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
`execute_steps`, including static lines in a multiline f-string. Use **Trigger
Suggest** if suggestions do not open while typing
inside the string. Shared Python modules receive suggestions from the suites
that import them.

## Select a scenario for F5

In a Behave launch configuration that filters by name, use the following
arguments to select the scenario under the cursor:

```json
"args": ["${file}", "-n", "${command:toolium-cucumber.scenarioName}"]
```

Keep the project's interpreter, working directory, environment, and other
arguments. The command returns the Gherkin title from the scenario header,
its steps, or its Examples block. An Examples row resolves to the whole
Scenario Outline. Behave applies the project's normal selection and skip
rules. The launch stops if the active file is invalid or the cursor is
outside a named scenario.

Behave treats `-n` as a name pattern. Duplicate names or regular expression
characters can affect which scenarios match, just as with a manually
selected title.

## Collect Behave results

To record results from an existing `debugpy` launch that uses the `behave`
module, append the packaged formatter directory to the launch configuration's
`PYTHONPATH`. Keep the existing arguments, interpreter, and environment. For
example, add these formatter arguments to a launch that uses the default
terminal formatter:

```json
"env": {
  "PYTHONPATH": "${workspaceFolder}:${command:toolium-cucumber.behaveFormatterPath}"
},
"args": [
  "${file}", "-n", "${command:toolium-cucumber.scenarioName}",
  "--format", "toolium_cucumber_results:ResultsFormatter",
  "--outfile", "${workspaceFolder}/.vscode/behave-results.jsonl",
  "--format", "pretty"
]
```

Use `;` between Python import directories on Windows. If the launch already
specifies formatters and output files, keep their order and pair each formatter
with its output. Use a distinct results file for each simultaneous run. A new
run replaces the file at its configured path.

The formatter writes one JSON object per line. The stream includes feature
locations, scenario and outline row identities, step results, durations in
seconds, and error messages when Behave exposes them. Locations use one-based
line numbers. `runFinished` marks formatter teardown. Behave continues to
apply the project's hooks, filters, and skip rules and print its normal
terminal output using the existing terminal formatter.

### View Scenario Results

When the configured Behave launch starts, Toolium Cucumber opens
**Scenario Results** beside the editor and updates it as Behave records
results. The tab lists steps in execution order and groups Outline results
by Examples row. Expand any scenario or row to see its steps, durations,
and available failure details. Stopping the debugger preserves results
already recorded. The view distinguishes completed, cancelled, and
interrupted runs.

To open a saved report, run **Toolium Cucumber: Show Scenario Results** from
the Command Palette and select its `.jsonl` file. The view expects a completed
report. The integrated terminal remains available for the full output.

## Diagnose missing steps

In a trusted workspace, the extension checks the steps in an open feature
against its suite. It expands each populated Scenario Outline using its Examples
rows and reports missing columns referenced by the step text, tables, or doc
strings. When static discovery detects unsupported Python definitions or imports,
it reports incomplete validation on the relevant Python source lines in
Problems and suppresses undefined-step warnings.

For an undefined step, choose **Create Python step definition** from the Quick
Fix menu. The action creates a new module in the suite's `steps` directory
without overwriting existing files. If several example values are unresolved,
choose the value to scaffold.

## Navigate Toolium resources

In a `.feature` or Python file, place the cursor inside a resource placeholder.
Choose **Open resource** in the hover or run **Toolium Cucumber: Open Resource**
from the Command Palette or editor context menu. The context menu offers the
command when the cursor is inside a recognized placeholder. A single match opens directly.
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

## Write feature blocks

In a `.feature` file, use **Insert Snippet** or type a snippet prefix and choose
the suggestion. Use Tab to move through its editable fields. The English
Gherkin snippets cover features, rules, backgrounds, scenarios, outlines, and
Examples. Try `gherkin-scenario`, `gherkin-outline`, or `gherkin-examples`.
The outline snippet links the example column name to its placeholder in the step.

For Toolium actions, use `toolium-before-feature`, `toolium-after-feature`,
`toolium-before-scenario`, or `toolium-after-scenario`.

Pressing Enter after a Gherkin section heading or Toolium action heading
indents the next line using the editor's indentation settings. Gherkin headings
are recognized across supported dialects.

## Format feature files

Run **Format Document** in a `.feature` file to reindent Gherkin sections, tags,
steps, and arguments and align table columns. The formatter uses the editor's
tab size and indentation style. It preserves comments, descriptions, Toolium
action blocks, doc string content, and table values. It skips files with
syntax errors and discards any edits that would change the parsed feature.

To format features when saving, enable the standard VS Code setting for Gherkin:

```json
{
  "[gherkin]": {
    "editor.formatOnSave": true
  }
}
```

## Development

Run `npm ci` to install dependencies and `npm test` to build and run the tests.
Press F5 in VS Code to launch an Extension Development Host and try the
`test/fixtures/observatory.feature` example.

Run `npm run test:vscode` to verify Python completion, feature diagnostics, quick
fixes, and resource navigation in an isolated VS Code instance. The runner uses
`code` on PATH by default. Set `VSCODE_EXECUTABLE` to the VS Code CLI path if needed.
