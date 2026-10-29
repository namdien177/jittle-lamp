//! YUV conversions.
//!
//! GPUI's Metal renderer draws `surface()` content only from
//! `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange` (NV12, full range) buffers and converts
//! them with a BT.601 full-range matrix. libvpx hands out planar I420, usually studio range,
//! so decoded frames are expanded to full range and their chroma interleaved.

use std::ptr::{self, NonNull};

use anyhow::{Result, anyhow, bail};
use image::RgbaImage;
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
    CVPixelBufferGetHeightOfPlane, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidthOfPlane,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool,
    CVPixelBufferUnlockBaseAddress, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferMetalCompatibilityKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVReturnSuccess,
};

use crate::vpx::YuvPlanes;

/// The only surface pixel format GPUI's Metal renderer accepts.
pub const SURFACE_PIXEL_FORMAT: u32 = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange;

/// Studio-range luma (16–235) to full range.
static LUMA_TO_FULL: [u8; 256] = range_lut(false);
/// Studio-range chroma (16–240, centred on 128) to full range.
static CHROMA_TO_FULL: [u8; 256] = range_lut(true);

/// Builds `round((i - offset) * 255 / span) + centre`, clamped to 0..=255.
const fn range_lut(chroma: bool) -> [u8; 256] {
    let (offset, span, centre) = if chroma {
        (128, 224, 128)
    } else {
        (16, 219, 0)
    };
    let mut lut = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let num = (i as i32 - offset) * 255;
        let rounded = if num >= 0 {
            (2 * num + span) / (2 * span)
        } else {
            -((-2 * num + span) / (2 * span))
        };
        let value = rounded + centre;
        lut[i] = if value < 0 {
            0
        } else if value > 255 {
            255
        } else {
            value as u8
        };
        i += 1;
    }
    lut
}

/// Writes `src` as full-range NV12 into the given luma and interleaved chroma planes.
/// `dst_width` × `dst_height` is the destination size; it must not exceed the source size.
pub fn write_nv12(
    src: &YuvPlanes<'_>,
    y_dst: &mut [u8],
    y_stride: usize,
    uv_dst: &mut [u8],
    uv_stride: usize,
    dst_width: usize,
    dst_height: usize,
) {
    let width = dst_width.min(src.width);
    let height = dst_height.min(src.height);
    for row in 0..height {
        let from = &src.y[row * src.y_stride..][..width];
        let to = &mut y_dst[row * y_stride..][..width];
        if src.full_range {
            to.copy_from_slice(from);
        } else {
            for (d, &s) in to.iter_mut().zip(from) {
                *d = LUMA_TO_FULL[s as usize];
            }
        }
    }

    let chroma = if src.full_range {
        None
    } else {
        Some(&CHROMA_TO_FULL)
    };
    let (cw, ch) = (width.div_ceil(2), height.div_ceil(2));
    let i420 = src.x_shift == 1 && src.y_shift == 1;
    for row in 0..ch {
        let src_row = (row * 2) >> src.y_shift;
        let u = &src.u[src_row * src.uv_stride..];
        let v = &src.v[src_row * src.uv_stride..];
        let to = &mut uv_dst[row * uv_stride..][..cw * 2];
        for (col, pair) in to.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let src_col = if i420 { col } else { (col * 2) >> src.x_shift };
            let (cb, cr) = (u[src_col], v[src_col]);
            match chroma {
                Some(lut) => {
                    pair[0] = lut[cb as usize];
                    pair[1] = lut[cr as usize];
                }
                None => {
                    pair[0] = cb;
                    pair[1] = cr;
                }
            }
        }
    }
}

/// Converts full-range BT.601 YCbCr to RGB, matching GPUI's surface shader.
#[inline]
fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8) -> [u8; 3] {
    let y = (y as i32) << 16;
    let cb = cb as i32 - 128;
    let cr = cr as i32 - 128;
    // 16.16 fixed point: 1.402, 0.344136, 0.714136, 1.772
    let r = y + 91881 * cr;
    let g = y - 22554 * cb - 46802 * cr;
    let b = y + 116130 * cb;
    let clamp = |v: i32| ((v + 32768) >> 16).clamp(0, 255) as u8;
    [clamp(r), clamp(g), clamp(b)]
}

/// Converts a planar YUV picture to an RGBA image.
pub fn yuv_to_rgba(src: &YuvPlanes<'_>) -> RgbaImage {
    let (width, height) = (src.width, src.height);
    let mut out = vec![0u8; width * height * 4];
    for row in 0..height {
        let y_row = &src.y[row * src.y_stride..][..width];
        let c_row = (row >> src.y_shift) * src.uv_stride;
        let (u, v) = (&src.u[c_row..], &src.v[c_row..]);
        let dst = &mut out[row * width * 4..][..width * 4];
        for (col, px) in dst.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let c = col >> src.x_shift;
            let (mut y, mut cb, mut cr) = (y_row[col], u[c], v[c]);
            if !src.full_range {
                y = LUMA_TO_FULL[y as usize];
                cb = CHROMA_TO_FULL[cb as usize];
                cr = CHROMA_TO_FULL[cr as usize];
            }
            let [r, g, b] = ycbcr_to_rgb(y, cb, cr);
            px.copy_from_slice(&[r, g, b, 255]);
        }
    }
    RgbaImage::from_raw(width as u32, height as u32, out).expect("buffer sized for image")
}

/// Converts an NV12 pixel buffer (`420f` or `420v`, as produced by this crate or by
/// AVFoundation) to RGBA, e.g. for the "copy frame" button.
pub fn pixel_buffer_to_rgba(buffer: &CVPixelBuffer) -> Result<RgbaImage> {
    let format = CVPixelBufferGetPixelFormatType(buffer);
    let full_range = match format {
        f if f == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange => true,
        f if f == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange => false,
        other => bail!("unsupported pixel format {}", fourcc(other)),
    };
    let _lock = BaseAddressLock::new(buffer, CVPixelBufferLockFlags::ReadOnly)?;
    let width = CVPixelBufferGetWidthOfPlane(buffer, 0);
    let height = CVPixelBufferGetHeightOfPlane(buffer, 0);
    let y_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
    let uv_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1);
    let uv_height = CVPixelBufferGetHeightOfPlane(buffer, 1);
    let y_base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) as *const u8;
    let uv_base = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) as *const u8;
    if y_base.is_null() || uv_base.is_null() {
        bail!("pixel buffer has no CPU-visible planes");
    }
    let y = unsafe { std::slice::from_raw_parts(y_base, y_stride * height) };
    let uv = unsafe { std::slice::from_raw_parts(uv_base, uv_stride * uv_height) };
    Ok(nv12_to_rgba(
        y, y_stride, uv, uv_stride, width, height, full_range,
    ))
}

pub fn nv12_to_rgba(
    y: &[u8],
    y_stride: usize,
    uv: &[u8],
    uv_stride: usize,
    width: usize,
    height: usize,
    full_range: bool,
) -> RgbaImage {
    let mut out = vec![0u8; width * height * 4];
    for row in 0..height {
        let y_row = &y[row * y_stride..][..width];
        let uv_row = &uv[(row / 2) * uv_stride..];
        let dst = &mut out[row * width * 4..][..width * 4];
        for (col, px) in dst.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let c = (col / 2) * 2;
            let (mut l, mut cb, mut cr) = (y_row[col], uv_row[c], uv_row[c + 1]);
            if !full_range {
                l = LUMA_TO_FULL[l as usize];
                cb = CHROMA_TO_FULL[cb as usize];
                cr = CHROMA_TO_FULL[cr as usize];
            }
            let [r, g, b] = ycbcr_to_rgb(l, cb, cr);
            px.copy_from_slice(&[r, g, b, 255]);
        }
    }
    RgbaImage::from_raw(width as u32, height as u32, out).expect("buffer sized for image")
}

/// A `CVPixelBufferPool` of IOSurface-backed, Metal-compatible `420f` buffers of one size.
pub struct SurfacePool {
    pool: CFRetained<CVPixelBufferPool>,
    width: usize,
    height: usize,
}

// SAFETY: CVPixelBufferPool is thread-safe (CoreVideo documents pools as usable from any thread).
unsafe impl Send for SurfacePool {}
unsafe impl Sync for SurfacePool {}

impl SurfacePool {
    pub fn new(width: usize, height: usize) -> Result<Self> {
        if width == 0 || height == 0 {
            bail!("empty frame size {width}x{height}");
        }
        let number = |n: i64| CFNumber::new_i64(n);
        let format = number(SURFACE_PIXEL_FORMAT as i64);
        let w = number(width as i64);
        let h = number(height as i64);
        let iosurface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
        let metal = CFBoolean::new(true);
        let keys: [&CFString; 5] = unsafe {
            [
                kCVPixelBufferPixelFormatTypeKey,
                kCVPixelBufferWidthKey,
                kCVPixelBufferHeightKey,
                kCVPixelBufferIOSurfacePropertiesKey,
                kCVPixelBufferMetalCompatibilityKey,
            ]
        };
        let values: [&CFType; 5] = [&format, &w, &h, &iosurface, metal];
        let attributes = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);

        let mut pool: *mut CVPixelBufferPool = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferPool::create(
                None,
                None,
                Some(attributes.as_opaque()),
                NonNull::from(&mut pool),
            )
        };
        let pool = NonNull::new(pool).filter(|_| status == kCVReturnSuccess);
        let pool = pool.ok_or_else(|| anyhow!("CVPixelBufferPoolCreate failed ({status})"))?;
        Ok(Self {
            pool: unsafe { CFRetained::from_raw(pool) },
            width,
            height,
        })
    }

    pub fn size(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    /// Takes a buffer from the pool and fills it with `src` as full-range NV12.
    pub fn upload(&self, src: &YuvPlanes<'_>) -> Result<CFRetained<CVPixelBuffer>> {
        let mut out: *mut CVPixelBuffer = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferPool::create_pixel_buffer(None, &self.pool, NonNull::from(&mut out))
        };
        let out = NonNull::new(out).filter(|_| status == kCVReturnSuccess);
        let out =
            out.ok_or_else(|| anyhow!("CVPixelBufferPoolCreatePixelBuffer failed ({status})"))?;
        let buffer = unsafe { CFRetained::from_raw(out) };
        {
            let _lock = BaseAddressLock::new(&buffer, CVPixelBufferLockFlags::empty())?;
            let y_stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, 0);
            let uv_stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, 1);
            let y_rows = CVPixelBufferGetHeightOfPlane(&buffer, 0);
            let uv_rows = CVPixelBufferGetHeightOfPlane(&buffer, 1);
            let y_base = CVPixelBufferGetBaseAddressOfPlane(&buffer, 0) as *mut u8;
            let uv_base = CVPixelBufferGetBaseAddressOfPlane(&buffer, 1) as *mut u8;
            if y_base.is_null() || uv_base.is_null() {
                bail!("pixel buffer has no CPU-visible planes");
            }
            let y = unsafe { std::slice::from_raw_parts_mut(y_base, y_stride * y_rows) };
            let uv = unsafe { std::slice::from_raw_parts_mut(uv_base, uv_stride * uv_rows) };
            write_nv12(src, y, y_stride, uv, uv_stride, self.width, self.height);
        }
        Ok(buffer)
    }
}

struct BaseAddressLock<'a> {
    buffer: &'a CVPixelBuffer,
    flags: CVPixelBufferLockFlags,
}

impl<'a> BaseAddressLock<'a> {
    fn new(buffer: &'a CVPixelBuffer, flags: CVPixelBufferLockFlags) -> Result<Self> {
        let status = unsafe { CVPixelBufferLockBaseAddress(buffer, flags) };
        if status != kCVReturnSuccess {
            bail!("CVPixelBufferLockBaseAddress failed ({status})");
        }
        Ok(Self { buffer, flags })
    }
}

impl Drop for BaseAddressLock<'_> {
    fn drop(&mut self) {
        unsafe { CVPixelBufferUnlockBaseAddress(self.buffer, self.flags) };
    }
}

fn fourcc(code: u32) -> String {
    let bytes = code.to_be_bytes();
    if bytes.iter().all(|b| b.is_ascii_graphic()) {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        format!("{code:#x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_video::{
        CVPixelBufferGetHeight, CVPixelBufferGetPlaneCount, CVPixelBufferGetWidth,
    };

    /// A 7×5 I420 picture (odd size: chroma is 4×3) with padded strides, studio range.
    struct Picture {
        y: Vec<u8>,
        u: Vec<u8>,
        v: Vec<u8>,
    }

    const W: usize = 7;
    const H: usize = 5;
    const Y_STRIDE: usize = 16;
    const UV_STRIDE: usize = 8;

    fn picture() -> Picture {
        let mut y = vec![0xEE; Y_STRIDE * H];
        let mut u = vec![0xEE; UV_STRIDE * 3];
        let mut v = vec![0xEE; UV_STRIDE * 3];
        for row in 0..H {
            for col in 0..W {
                y[row * Y_STRIDE + col] = (16 + row * 40 + col * 5) as u8;
            }
        }
        for row in 0..3 {
            for col in 0..4 {
                u[row * UV_STRIDE + col] = (16 + row * 70 + col * 10) as u8;
                v[row * UV_STRIDE + col] = (240 - row * 70 - col * 10) as u8;
            }
        }
        Picture { y, u, v }
    }

    fn planes(p: &Picture, full_range: bool) -> YuvPlanes<'_> {
        YuvPlanes {
            width: W,
            height: H,
            y: &p.y,
            u: &p.u,
            v: &p.v,
            y_stride: Y_STRIDE,
            uv_stride: UV_STRIDE,
            x_shift: 1,
            y_shift: 1,
            full_range,
        }
    }

    #[test]
    fn studio_range_expands_to_full_range() {
        assert_eq!(LUMA_TO_FULL[16], 0);
        assert_eq!(LUMA_TO_FULL[235], 255);
        assert_eq!(LUMA_TO_FULL[0], 0);
        assert_eq!(LUMA_TO_FULL[255], 255);
        assert_eq!(LUMA_TO_FULL[126], 128); // (126-16)*255/219 = 128.08
        assert_eq!(CHROMA_TO_FULL[128], 128);
        assert_eq!(CHROMA_TO_FULL[16], 0); // (16-128)*255/224 + 128 = 0.5 → 0 (round half away from centre)
        assert_eq!(CHROMA_TO_FULL[240], 255);
        assert!(LUMA_TO_FULL.windows(2).all(|w| w[0] <= w[1]));
        assert!(CHROMA_TO_FULL.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn i420_to_nv12_interleaves_and_expands() {
        let p = picture();
        let (ys, uvs) = (10, 12);
        let mut y = vec![0u8; ys * H];
        let mut uv = vec![0u8; uvs * 3];
        write_nv12(&planes(&p, false), &mut y, ys, &mut uv, uvs, W, H);
        for row in 0..H {
            for col in 0..W {
                assert_eq!(
                    y[row * ys + col],
                    LUMA_TO_FULL[p.y[row * Y_STRIDE + col] as usize]
                );
            }
        }
        for row in 0..3 {
            for col in 0..4 {
                assert_eq!(
                    uv[row * uvs + col * 2],
                    CHROMA_TO_FULL[p.u[row * UV_STRIDE + col] as usize]
                );
                assert_eq!(
                    uv[row * uvs + col * 2 + 1],
                    CHROMA_TO_FULL[p.v[row * UV_STRIDE + col] as usize]
                );
            }
        }
        // Full-range input is copied unchanged.
        write_nv12(&planes(&p, true), &mut y, ys, &mut uv, uvs, W, H);
        assert_eq!(&y[..W], &p.y[..W]);
        assert_eq!(&uv[..2], &[p.u[0], p.v[0]]);
    }

    #[test]
    fn i444_chroma_is_subsampled() {
        let y = vec![100u8; 4 * 2];
        let u: Vec<u8> = (0..8).map(|i| 100 + i).collect();
        let v: Vec<u8> = (0..8).map(|i| 200 - i).collect();
        let src = YuvPlanes {
            width: 4,
            height: 2,
            y: &y,
            u: &u,
            v: &v,
            y_stride: 4,
            uv_stride: 4,
            x_shift: 0,
            y_shift: 0,
            full_range: true,
        };
        let (mut ny, mut nuv) = (vec![0u8; 8], vec![0u8; 4]);
        write_nv12(&src, &mut ny, 4, &mut nuv, 4, 4, 2);
        assert_eq!(nuv, vec![100, 200, 102, 198]);
    }

    #[test]
    fn upload_into_pooled_420f_buffer() {
        let p = picture();
        let pool = SurfacePool::new(W, H).unwrap();
        for _ in 0..8 {
            let buffer = pool.upload(&planes(&p, false)).unwrap();
            assert_eq!(
                CVPixelBufferGetPixelFormatType(&buffer),
                SURFACE_PIXEL_FORMAT
            );
            assert_eq!(
                (
                    CVPixelBufferGetWidth(&buffer),
                    CVPixelBufferGetHeight(&buffer)
                ),
                (W, H)
            );
            assert_eq!(CVPixelBufferGetPlaneCount(&buffer), 2);
            assert_eq!(CVPixelBufferGetWidthOfPlane(&buffer, 1), 4);
            assert_eq!(CVPixelBufferGetHeightOfPlane(&buffer, 1), 3);
            // Reading back gives the same pixels as converting the I420 picture directly.
            let readback = pixel_buffer_to_rgba(&buffer).unwrap();
            assert!(readback == yuv_to_rgba(&planes(&p, false)));
        }
    }

    #[test]
    fn rgb_matches_bt601() {
        // Studio-range BT.601 primaries.
        let cases = [
            ([16, 128, 128], [0, 0, 0]),
            ([235, 128, 128], [255, 255, 255]),
            ([81, 90, 240], [255, 0, 0]),
            ([145, 54, 34], [0, 255, 0]),
            ([41, 240, 110], [0, 0, 255]),
        ];
        for ([y, cb, cr], rgb) in cases {
            let got = ycbcr_to_rgb(LUMA_TO_FULL[y], CHROMA_TO_FULL[cb], CHROMA_TO_FULL[cr]);
            for c in 0..3 {
                assert!(
                    got[c].abs_diff(rgb[c]) <= 3,
                    "{:?} -> {got:?}, want {rgb:?}",
                    [y, cb, cr]
                );
            }
        }
    }
}
