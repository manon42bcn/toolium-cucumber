# Toolium Cucumber

A VS Code extension for editing `.feature` files in Toolium projects.

The extension highlights Gherkin syntax and supports line comments, section folding,
and navigation in the Outline view. Syntax validation uses the dialect specified
by `# language` and defaults to English.

Hover over a section heading to see its effective tags and where they were
declared. Run **Toolium Cucumber: Find by Tag in This Feature** to jump to a
section with a matching declared or inherited tag. The extension marks tags with
placeholders, such as `@record:<figure>`, as errors on regular scenarios.

## Development

Run `npm ci` to install dependencies and `npm test` to build and run the tests.
Press F5 in VS Code to launch an Extension Development Host and try the
`test/fixtures/observatory.feature` example.
