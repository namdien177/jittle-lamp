# HQ admin logout returns a clean login form
Key: TC-0412
Tags: team:qa-pcf, module:admin, feature:login, regression
Env: pcf-uat
Links: https://littlelives.atlassian.net/browse/PCF-1234
Params: role=HQ_ADMIN

[Open] /login
[Login: {role}] đăng nhập tài khoản {role} PCF
[Act] mở menu tài khoản ở góc trên bên phải và chọn "Đăng xuất"

## Checkpoint: Logout returns to the login page
[Assert] trang hiện lại form đăng nhập với ô Email và Mật khẩu
[Assert] input text Email phải trống

# Branch admin logout returns a clean login form
Duplicate-of: TC-0412
Params: role=BRANCH_ADMIN

# Enrol a student for each level
Description: Creates one enrolment per dataset row.
  Rows come from the admissions sheet.
Tags: module:enrolment, prio:p1
Retries: 1

[Login: profile=PCF_HQ_ADMIN, tenant=HQ]
[Open] /students/new
Enter {studentName} into the Name field
[Select level: level={level}]
// [Act] click "Save draft"
[Act] click "Enrol"

## Checkpoint: Student is enrolled
[Assert] the student list shows {studentName} with level {level}
[Extract: studentId] the id shown in the student detail header
[Screenshot] enrolled student

## Dataset
| studentName | level |
| --- | --- |
| E2E Ann | K1 |
| E2E Bob | K2 |
