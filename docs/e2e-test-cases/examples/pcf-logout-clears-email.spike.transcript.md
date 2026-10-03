# HQ admin logout returns a clean login form

[Open] /login
[Login: PCF] đăng nhập tài khoản HQ_ADMIN PCF
[Assert] trang sau đăng nhập hiện tiêu đề trang và menu điều hướng chính
[Act] mở menu tài khoản ở góc trên bên phải và chọn "Đăng xuất"

## Checkpoint: Logout returns to the login page
[Assert] trang hiện lại form đăng nhập với ô Email và Mật khẩu
[Assert] input text Email phải trống
[Screenshot] login form after logout

## Checkpoint: Session is really gone
[Open] /enrolment-dashboard
[Assert] hệ thống chuyển hướng về trang đăng nhập, không hiện dashboard
[Note] Covers PCF-1234. Email autofill regression reported by school admins.
