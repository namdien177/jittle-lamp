//! Minimal libvpx decoder bindings (VP8 and VP9), written against libvpx 1.17 headers.

use std::ffi::{CStr, c_char, c_int, c_long, c_uint, c_void};
use std::ptr;

use anyhow::{Result, bail};

#[repr(C)]
struct CodecCtx {
    name: *const c_char,
    iface: *const c_void,
    err: c_int,
    err_detail: *const c_char,
    init_flags: c_long,
    config: *const c_void,
    priv_: *mut c_void,
}

#[repr(C)]
struct DecCfg {
    threads: c_uint,
    w: c_uint,
    h: c_uint,
}

#[repr(C)]
struct VpxImage {
    fmt: c_int,
    cs: c_int,
    range: c_int,
    w: c_uint,
    h: c_uint,
    bit_depth: c_uint,
    d_w: c_uint,
    d_h: c_uint,
    r_w: c_uint,
    r_h: c_uint,
    x_chroma_shift: c_uint,
    y_chroma_shift: c_uint,
    planes: [*mut u8; 4],
    stride: [c_int; 4],
    bps: c_int,
    user_priv: *mut c_void,
    img_data: *mut u8,
    img_data_owner: c_int,
    self_allocd: c_int,
    fb_priv: *mut c_void,
}

/// `VPX_IMAGE_ABI_VERSION (5) + 4 (codec) + 3 (decoder)`.
const VPX_DECODER_ABI_VERSION: c_int = 12;
const VPX_IMG_FMT_PLANAR: c_int = 0x100;
const VPX_IMG_FMT_UV_FLIP: c_int = 0x200;
const VPX_IMG_FMT_HIGHBITDEPTH: c_int = 0x800;
const VPX_CR_FULL_RANGE: c_int = 1;

unsafe extern "C" {
    fn vpx_codec_vp8_dx() -> *const c_void;
    fn vpx_codec_vp9_dx() -> *const c_void;
    fn vpx_codec_dec_init_ver(
        ctx: *mut CodecCtx,
        iface: *const c_void,
        cfg: *const DecCfg,
        flags: c_long,
        ver: c_int,
    ) -> c_int;
    fn vpx_codec_decode(
        ctx: *mut CodecCtx,
        data: *const u8,
        data_sz: c_uint,
        user_priv: *mut c_void,
        deadline: c_long,
    ) -> c_int;
    fn vpx_codec_get_frame(ctx: *mut CodecCtx, iter: *mut *const c_void) -> *mut VpxImage;
    fn vpx_codec_destroy(ctx: *mut CodecCtx) -> c_int;
    fn vpx_codec_error(ctx: *const CodecCtx) -> *const c_char;
    fn vpx_codec_error_detail(ctx: *const CodecCtx) -> *const c_char;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VpxCodec {
    Vp8,
    Vp9,
}

/// A borrowed 8-bit planar YUV picture. Chroma planes are subsampled by
/// `1 << x_shift` horizontally and `1 << y_shift` vertically (I420: 1, 1).
#[derive(Clone, Copy, Debug)]
pub struct YuvPlanes<'a> {
    pub width: usize,
    pub height: usize,
    pub y: &'a [u8],
    pub u: &'a [u8],
    pub v: &'a [u8],
    pub y_stride: usize,
    pub uv_stride: usize,
    pub x_shift: u32,
    pub y_shift: u32,
    /// Full-range (0–255) samples; otherwise studio range (Y 16–235, UV 16–240).
    pub full_range: bool,
}

pub struct Decoder {
    ctx: Box<CodecCtx>,
    /// The picture from the last `decode` call; owned by libvpx until the next one.
    last: *mut VpxImage,
}

// SAFETY: a libvpx context is not shared between threads; it is moved, never aliased.
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn new(codec: VpxCodec, threads: u32) -> Result<Self> {
        let iface = unsafe {
            match codec {
                VpxCodec::Vp8 => vpx_codec_vp8_dx(),
                VpxCodec::Vp9 => vpx_codec_vp9_dx(),
            }
        };
        let mut ctx = Box::new(CodecCtx {
            name: ptr::null(),
            iface: ptr::null(),
            err: 0,
            err_detail: ptr::null(),
            init_flags: 0,
            config: ptr::null(),
            priv_: ptr::null_mut(),
        });
        let cfg = DecCfg {
            threads: threads.max(1),
            w: 0,
            h: 0,
        };
        let status =
            unsafe { vpx_codec_dec_init_ver(&mut *ctx, iface, &cfg, 0, VPX_DECODER_ABI_VERSION) };
        if status != 0 {
            bail!("vpx_codec_dec_init failed ({status})");
        }
        Ok(Self {
            ctx,
            last: ptr::null_mut(),
        })
    }

    /// Decodes one compressed frame. Returns whether it produced a picture to show; read it
    /// with [`Decoder::last_picture`].
    pub fn decode(&mut self, data: &[u8]) -> Result<bool> {
        self.last = ptr::null_mut();
        let status = unsafe {
            vpx_codec_decode(
                &mut *self.ctx,
                data.as_ptr(),
                data.len() as c_uint,
                ptr::null_mut(),
                0,
            )
        };
        if status != 0 {
            bail!("vpx decode failed: {}", self.error());
        }
        let mut iter: *const c_void = ptr::null();
        loop {
            let img = unsafe { vpx_codec_get_frame(&mut *self.ctx, &mut iter) };
            if img.is_null() {
                break;
            }
            self.last = img;
        }
        if self.last.is_null() {
            return Ok(false);
        }
        let fmt = unsafe { (*self.last).fmt };
        if fmt & VPX_IMG_FMT_HIGHBITDEPTH != 0 || fmt & VPX_IMG_FMT_PLANAR == 0 {
            self.last = ptr::null_mut();
            bail!("unsupported vpx image format {fmt:#x} (only 8-bit planar YUV)");
        }
        Ok(true)
    }

    /// The picture produced by the last successful [`Decoder::decode`].
    pub fn last_picture(&self) -> Option<YuvPlanes<'_>> {
        if self.last.is_null() {
            return None;
        }
        let img = unsafe { &*self.last };
        let (width, height) = (img.d_w as usize, img.d_h as usize);
        let (xs, ys) = (img.x_chroma_shift, img.y_chroma_shift);
        let (cw, ch) = (
            (width + (1 << xs) - 1) >> xs,
            (height + (1 << ys) - 1) >> ys,
        );
        let y_stride = img.stride[0] as usize;
        let uv_stride = img.stride[1] as usize;
        let (mut u_plane, mut v_plane) = (img.planes[1], img.planes[2]);
        if img.fmt & VPX_IMG_FMT_UV_FLIP != 0 {
            std::mem::swap(&mut u_plane, &mut v_plane);
        }
        // SAFETY: libvpx guarantees `stride * (rows - 1) + cols` readable bytes per plane, and
        // the image lives until the next decode call, which needs `&mut self`.
        let plane = |p: *mut u8, stride: usize, rows: usize, cols: usize| unsafe {
            std::slice::from_raw_parts(p as *const u8, stride * (rows - 1) + cols)
        };
        Some(YuvPlanes {
            width,
            height,
            y: plane(img.planes[0], y_stride, height, width),
            u: plane(u_plane, uv_stride, ch, cw),
            v: plane(v_plane, uv_stride, ch, cw),
            y_stride,
            uv_stride,
            x_shift: xs,
            y_shift: ys,
            full_range: img.range == VPX_CR_FULL_RANGE,
        })
    }

    fn error(&self) -> String {
        let text = |p: *const c_char| {
            if p.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
            }
        };
        let message = text(unsafe { vpx_codec_error(&*self.ctx) });
        let detail = text(unsafe { vpx_codec_error_detail(&*self.ctx) });
        if detail.is_empty() {
            message
        } else {
            format!("{message} ({detail})")
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { vpx_codec_destroy(&mut *self.ctx) };
    }
}
