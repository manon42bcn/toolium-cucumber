"""Write Behave results as newline-delimited JSON for Toolium Cucumber."""

import json
from pathlib import Path

from behave.formatter.base import Formatter
from behave.model import ScenarioOutline


def location(statement):
    """Return a file and one-based source line for a Behave model element."""
    return {'file': str(Path(statement.filename).resolve()), 'line': statement.line}


class ResultsFormatter(Formatter):
    """Observe Behave execution and flush each event without changing test selection."""

    def __init__(self, stream_opener, config):
        """Initialize the formatter with Behave's assigned output stream."""
        super().__init__(stream_opener, config)
        self.scenario_id = 0
        self.current_scenario = None
        self.steps = {}
        self.reported = set()
        self.closed = False
        self.emit('runStarted', version=1)

    def emit(self, event, **fields):
        """Write and flush one complete JSON record."""
        stream = self.open()
        stream.write(json.dumps({'event': event, **fields}) + '\n')
        stream.flush()

    def feature(self, feature):
        """Record the feature associated with the following scenarios."""
        self.emit('feature', name=feature.name, location=location(feature))

    def scenario(self, scenario):
        """Start a scenario or one expanded row of an outline."""
        self.finish_scenario()
        self.scenario_id += 1
        self.current_scenario = scenario
        self.steps.clear()
        self.reported.clear()
        outline = scenario.parent if isinstance(scenario.parent, ScenarioOutline) else None
        example = {'name': outline.name, 'location': location(outline), 'rowLine': scenario.line} if outline else None
        self.emit('scenarioStarted', scenarioId=self.scenario_id, name=scenario.name,
                  location=location(scenario), example=example)

    def step(self, step):
        """Declare a step in the order reported by Behave."""
        step_id = len(self.steps) + 1
        self.steps[id(step)] = step_id
        self.emit('step', scenarioId=self.scenario_id, stepId=step_id,
                  keyword=step.keyword.strip(), name=step.name, location=location(step))

    def result(self, step):
        """Record a step's result as soon as Behave reports it."""
        if id(step) not in self.steps:
            self.step(step)
        self.reported.add(id(step))
        self.emit('stepFinished', scenarioId=self.scenario_id, stepId=self.steps[id(step)],
                  status=step.status.name, duration=step.duration, error=step.error_message or None)

    def match(self, match):
        """Mark the next declared step active when Behave resolves its definition."""
        # Behave calls match() in execution order, before result() exposes the step object.
        step_id = len(self.reported) + 1
        if step_id <= len(self.steps):
            self.emit('stepStarted', scenarioId=self.scenario_id, stepId=step_id)

    def finish_scenario(self):
        """Report remaining step states and the scenario status after its hooks have run."""
        scenario = self.current_scenario
        if scenario is None:
            return
        # Behave can mark steps skipped after a failure without calling result().
        for step in scenario.all_steps:
            if id(step) not in self.reported:
                self.result(step)
        self.emit('scenarioFinished', scenarioId=self.scenario_id, status=scenario.status.name,
                  duration=scenario.duration, error=getattr(scenario, 'error_message', None) or None)
        self.current_scenario = None

    def eof(self):
        """Complete the final scenario in the feature."""
        self.finish_scenario()

    def close(self):
        """Close the stream and mark that the formatter reached normal teardown."""
        if self.closed:
            return
        self.closed = True
        try:
            self.finish_scenario()
            self.emit('runFinished')
        finally:
            super().close()
