# language: en
@observatory
Feature: Constellation log

  Rule: Each observation belongs to a session
    Background:
      Given an empty lunar notebook

    @record
    Scenario Outline: Record an observation
      When I draw the constellation <figure>
        """
        Diagram of <figure>
        """
      Then the notebook contains the following entry
        | type | name     |
        | star | <figure> |

      Examples:
        | figure |
        | Spiral |
