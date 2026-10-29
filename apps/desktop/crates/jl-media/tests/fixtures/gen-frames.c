// Generates vp8.frames / vp9.frames: a small moving test pattern encoded with libvpx.
//   clang -I$(brew --prefix libvpx)/include gen-frames.c $(brew --prefix libvpx)/lib/libvpx.a -o gen
//   ./gen vp8 vp8.frames && ./gen vp9 vp9.frames
// Output format: repeated [u32 le size][u8 keyframe][u64 le pts_ms][size bytes].
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vpx/vpx_encoder.h>
#include <vpx/vp8cx.h>

int main(int argc, char **argv) {
  const char *codec = argv[1]; const char *out = argv[2];
  int w = 66, h = 38, frames = 12;  // odd chroma-friendly sizes exercise rounding
  vpx_codec_iface_t *iface = strcmp(codec, "vp9") == 0 ? vpx_codec_vp9_cx() : vpx_codec_vp8_cx();
  vpx_codec_enc_cfg_t cfg; vpx_codec_enc_config_default(iface, &cfg, 0);
  cfg.g_w = w; cfg.g_h = h; cfg.g_timebase.num = 1; cfg.g_timebase.den = 1000;
  cfg.rc_target_bitrate = 200; cfg.kf_mode = VPX_KF_AUTO; cfg.kf_min_dist = 0; cfg.kf_max_dist = 5;
  cfg.g_lag_in_frames = 0; cfg.g_error_resilient = 0;
  vpx_codec_ctx_t ctx; if (vpx_codec_enc_init(&ctx, iface, &cfg, 0)) { fprintf(stderr, "init\n"); return 1; }
  vpx_image_t img; vpx_img_alloc(&img, VPX_IMG_FMT_I420, w, h, 1);
  FILE *f = fopen(out, "wb");
  for (int i = 0; i <= frames; i++) {
    vpx_image_t *in = NULL;
    if (i < frames) {
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) img.planes[0][y*img.stride[0]+x] = 16 + ((x*3 + y*2 + i*9) % 220);
      for (int y = 0; y < (h+1)/2; y++) for (int x = 0; x < (w+1)/2; x++) { img.planes[1][y*img.stride[1]+x] = 64 + (x*4)%128; img.planes[2][y*img.stride[2]+x] = 192 - (y*5)%128; }
      in = &img;
    }
    long long pts = (long long)i * 40;
    if (vpx_codec_encode(&ctx, in, pts, 40, 0, VPX_DL_GOOD_QUALITY)) { fprintf(stderr, "encode\n"); return 1; }
    const vpx_codec_cx_pkt_t *pkt; vpx_codec_iter_t it = NULL;
    while ((pkt = vpx_codec_get_cx_data(&ctx, &it))) {
      if (pkt->kind != VPX_CODEC_CX_FRAME_PKT) continue;
      unsigned int sz = pkt->data.frame.sz; unsigned char key = (pkt->data.frame.flags & VPX_FRAME_IS_KEY) ? 1 : 0;
      unsigned long long p = pkt->data.frame.pts;
      fwrite(&sz, 4, 1, f); fwrite(&key, 1, 1, f); fwrite(&p, 8, 1, f); fwrite(pkt->data.frame.buf, 1, sz, f);
    }
  }
  fclose(f); vpx_codec_destroy(&ctx); return 0;
}
