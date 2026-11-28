"""Exercise the packaged result formatter with an installed Behave interpreter."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class BehaveResultsTest(unittest.TestCase):
    """Compare the same synthetic suite with and without result collection."""

    def test_reports_outline_rows_failures_and_skips(self):
        """Preserve terminal output and report step and hook failures separately."""
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            features = workspace / 'features'
            (features / 'steps').mkdir(parents=True)
            (features / 'cart.feature').write_text(
                'Feature: Cart\n'
                '  Background:\n'
                '    Given a cart\n'
                '  Scenario Outline: Check the total\n'
                '    Then the total is <total>\n'
                '    And the cart remains open\n'
                '    Examples:\n'
                '      | total |\n'
                '      | 1     |\n'
                '      | 2     |\n'
                '    @skip\n'
                '    Examples: Skipped\n'
                '      | total |\n'
                '      | 3     |\n'
                '    @bug\n'
                '    Examples: Known issue\n'
                '      | total |\n'
                '      | 4     |\n'
                '  @broken_hook\n'
                '  Scenario: Fail during setup\n'
                '    Given a cart\n',
                encoding='utf-8',
            )
            (features / 'environment.py').write_text(
                'def before_scenario(context, scenario):\n'
                '    """Skip marked examples and simulate a setup error."""\n'
                '    if set(scenario.effective_tags) & {"skip", "bug"}:\n'
                '        scenario.skip("Excluded by the project")\n'
                '    if "broken_hook" in scenario.tags:\n'
                '        raise RuntimeError("Setup failed")\n',
                encoding='utf-8',
            )
            (features / 'steps' / 'cart.py').write_text(
                'from behave import given, then\n'
                '@given("a cart")\n'
                'def open_cart(context):\n'
                '    """Set the current total."""\n'
                '    context.total = 1\n'
                '@then("the total is {total:d}")\n'
                'def check_total(context, total):\n'
                '    """Check the requested total."""\n'
                '    assert context.total == total, "Wrong total"\n'
                '@then("the cart remains open")\n'
                'def check_cart(context):\n'
                '    """Check that setup ran."""\n'
                '    assert context.total == 1\n',
                encoding='utf-8',
            )
            formatter_path = Path(__file__).resolve().parents[1] / 'python'
            env = os.environ.copy()
            env['PYTHONPATH'] = os.pathsep.join(filter(None, [str(formatter_path), env.get('PYTHONPATH')]))
            result_file = workspace / 'results.jsonl'
            command = [sys.executable, '-m', 'behave', '--no-color']
            baseline = subprocess.run(
                [*command, '--format', 'pretty'], cwd=workspace, env=env, capture_output=True, text=True,
            )
            collected = subprocess.run(
                [*command, '--format', 'toolium_cucumber_results:ResultsFormatter',
                 '--outfile', str(result_file), '--format', 'pretty'],
                cwd=workspace, env=env, capture_output=True, text=True,
            )
            self.assertEqual(baseline.returncode, 1, baseline.stderr)
            self.assertEqual(collected.returncode, baseline.returncode, collected.stderr)
            self.assertEqual(collected.stdout.split('Took ')[0], baseline.stdout.split('Took ')[0])
            events = [json.loads(line) for line in result_file.read_text(encoding='utf-8').splitlines()]
            self.assertEqual(events[0], {'event': 'runStarted', 'version': 1})
            self.assertEqual(events[-1], {'event': 'runFinished'})
            examples = [event['example'] for event in events if event['event'] == 'scenarioStarted' and event['example']]
            self.assertEqual([example['rowLine'] for example in examples], [9, 10, 14, 18])
            self.assertTrue(all(example['location']['line'] == 4 for example in examples))
            scenarios = [event for event in events if event['event'] == 'scenarioFinished']
            self.assertEqual([event['status'] for event in scenarios], [
                'passed', 'failed', 'skipped', 'skipped', 'hook_error',
            ])
            self.assertIn('Setup failed', scenarios[-1]['error'])
            failed_steps = [event for event in events if event['event'] == 'stepFinished' and event['scenarioId'] == 2]
            self.assertEqual([event['status'] for event in failed_steps], ['passed', 'failed', 'skipped'])
            self.assertIn('Wrong total', failed_steps[1]['error'])
            started = next(index for index, event in enumerate(events)
                           if event['event'] == 'stepStarted' and event['scenarioId'] == 2)
            self.assertEqual(events[started]['stepId'], failed_steps[0]['stepId'])
            self.assertLess(started, events.index(failed_steps[0]))


if __name__ == '__main__':
    unittest.main()
