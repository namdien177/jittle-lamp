@team:qa-pcf @feature:parent-portal
Feature: Parent portal login

  Background:
    Given I open the parent portal login page

  Scenario: Parent signs in with email and OTP
    When I enter the primary applicant email
    And I submit the one-time code {OTP_CODE}
    Then the dashboard shows the child's name
    And the menu shows "Đăng xuất"

  @prio:p1
  Scenario Outline: Wrong OTP is rejected for <role>
    When I sign in as <role> with OTP "<otp>"
    Then an error says the code is invalid

    Examples:
      | role    | otp    |
      | parent  | 000000 |
      | guardian| 111111 |
