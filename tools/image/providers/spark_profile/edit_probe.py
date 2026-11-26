#!/usr/bin/env python3
"""Resolve and warm the pinned H3 Image FA4 shapes for a single native 576x1024 portrait edit."""

import argparse
from functools import partial
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

from fa4_2k_probe import cache_root, file_digest, install_cache_trace, read_json, write_json


def geometry(args):
    from PIL import Image, ImageOps
    from transformers import AutoProcessor, AutoTokenizer

    from sglang.multimodal_gen.configs.pipeline_configs.minimax_h3_image import (
        MiniMaxH3ImagePipelineConfig,
    )
    from sglang.multimodal_gen.runtime.models.encoders.qwen3vl import Qwen3VLModel
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.image_noise import (
        minimax_h3_image_reference_grid,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_sequence import (
        minimax_h3_packed_sequence_ref2va_blocks,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.presentation import (
        minimax_h3_image_presentation,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (
        minimax_h3_bound_image_reference,
    )

    sampling = read_json(args.sampling)
    prompt = sampling["prompt"]
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("expected one nonempty edit prompt")
    if (sampling["width"], sampling["height"], sampling["min_generation_area"]) != (864, 1536, 864 * 1536):
        raise ValueError("unexpected native portrait request")
    pipeline = MiniMaxH3ImagePipelineConfig()
    pipeline.load_from_json("/portrait_pipeline.json")
    if pipeline.min_generation_area != 864 * 1536 or any(
        pipeline.edit_reference_short_edge_bounds(c) != (576, 576) for c in ("qwen", "vae")
    ):
        raise ValueError("unexpected portrait pipeline configuration")

    model = Path(args.model_root)
    index = read_json(model / "model_index.json")
    tokenizer = AutoTokenizer.from_pretrained(
        model / "tokenizer", padding_side="right",
        use_fast=index["tokenizer"][1] != "Qwen2Tokenizer", local_files_only=True,
    )
    processor = AutoProcessor.from_pretrained(model / "processor", local_files_only=True)
    config = read_json(model / "transformer/config.json")
    heads = config["num_attention_heads"]
    head_dim = config["attention_head_dim"]
    if config["patch_size"] != [1, 2, 2] or (heads, head_dim) != (56, 128):
        raise ValueError("unexpected H3 Image transformer geometry")

    reference = Path(args.reference)
    with Image.open(reference) as source:
        if source.format != "PNG" or getattr(source, "n_frames", 1) != 1:
            raise ValueError("expected one nonanimated reference PNG")
        upright = ImageOps.exif_transpose(source).convert("RGB")
    if upright.size != (720, 1280):
        raise ValueError("expected the complete portrait reference at 720x1280")

    qwen_low, qwen_high = pipeline.edit_reference_short_edge_bounds("qwen")
    qwen_image = minimax_h3_bound_image_reference(
        upright, min_short_edge=qwen_low, max_short_edge=qwen_high,
    )
    vision = processor.image_processor(images=[qwen_image], return_tensors="pt")
    vision_grid = vision["image_grid_thw"]
    merge = int(processor.image_processor.merge_size)
    if vision_grid.shape != (1, 3) or merge <= 0:
        raise RuntimeError("unexpected Qwen single-image processor geometry")
    image_tokens = int(vision_grid[0].prod().item()) // merge**2

    # The model's multimodal RoPE helper depends only on a few config fields
    # when an image grid is supplied, so no text-encoder module is constructed.
    encoder = read_json(args.text_encoder_config)
    rope_config = SimpleNamespace(
        vision_config=SimpleNamespace(
            spatial_merge_size=encoder["vision_config"]["spatial_merge_size"],
        ),
        image_token_id=encoder["image_token_id"],
        video_token_id=encoder["video_token_id"],
        vision_start_token_id=encoder["vision_start_token_id"],
    )
    if rope_config.vision_config.spatial_merge_size != merge or image_tokens < 1:
        raise RuntimeError("Qwen processor and encoder image grids disagree")
    get_rope_index = partial(
        Qwen3VLModel.get_rope_index, SimpleNamespace(config=rope_config),
    )
    ids, tags, positions = minimax_h3_image_presentation(
        tokenizer,
        prompt=prompt,
        image_token_counts=[image_tokens],
        get_rope_index=get_rope_index,
        image_grid_thw=vision_grid,
    )
    text_rows = tags.numel()
    if text_rows < 1 or ids.numel() % 8 or positions.shape != (3, 1, ids.numel()):
        raise RuntimeError("unexpected native Qwen presentation geometry")

    vae_low, vae_high = pipeline.edit_reference_short_edge_bounds("vae")
    vae_image = minimax_h3_bound_image_reference(
        upright, min_short_edge=vae_low, max_short_edge=vae_high,
    )
    ref_h, ref_w = minimax_h3_image_reference_grid(*vae_image.size)
    ref_rows = ref_h * ref_w // 4
    target_h, target_w = 1536 // 16, 864 // 16
    target_rows = target_h * target_w // 4
    used = text_rows + ref_rows + target_rows
    total = ((used + 15) // 16) * 16 + 16
    packed = minimax_h3_packed_sequence_ref2va_blocks(
        text_len=text_rows,
        latent_t=1, latent_h=target_h, latent_w=target_w, audio_t=0,
        ref_blocks=[{"kind": "image", "latent_h": ref_h, "latent_w": ref_w}],
        seq_len=total,
    )
    bounds = packed["cu_seqlens"].tolist()
    if bounds != [0, used, total] or packed["img_pos"].numel() != ref_rows + target_rows:
        raise RuntimeError("pinned packed edit layout disagrees with the expected geometry")
    value = {
        "task": "edit", "width": 864, "height": 1536,
        "dtype": "bfloat16", "heads": heads, "head_dim": head_dim,
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "reference_sha256": file_digest(reference),
        "reference_size": list(upright.size),
        "qwen_reference_size": list(qwen_image.size),
        "qwen_image_grid_thw": vision_grid.tolist(),
        "qwen_image_tokens": image_tokens,
        "qwen_padded_tokens": ids.numel(),
        "vae_reference_size": list(vae_image.size),
        "vae_reference_grid": [ref_h, ref_w],
        "vae_reference_rows": ref_rows,
        "target_rows": target_rows,
        "variants": [
            {"name": "refiner", "bounds": [0, text_rows, text_rows]},
            {"name": "main", "bounds": bounds},
        ],
    }
    write_json(args.output, value)
    print("FA4_GEOMETRY " + json.dumps(value, sort_keys=True), flush=True)


def warm(args):
    import torch
    from sglang.kernels.ops.attention.flash_attention import flash_attn_varlen_func

    root = cache_root()
    if any(root.iterdir()):
        raise RuntimeError("use a fresh task-owned FA4 warmup cache")
    spec = read_json(args.geometry)
    if (spec["task"], spec["width"], spec["height"], spec["dtype"], spec["heads"], spec["head_dim"]) != (
        "edit", 864, 1536, "bfloat16", 56, 128,
    ):
        raise ValueError("unexpected edit warmup geometry")
    if not torch.cuda.get_device_name(0).startswith("NVIDIA GB10"):
        raise RuntimeError("this geometry is scoped to Spark's GB10")
    heads, head_dim = spec["heads"], spec["head_dim"]
    refiner, main = spec["variants"]
    text_rows = refiner["bounds"][1]
    ref_h, ref_w = spec["vae_reference_grid"]
    reference_rows = ref_h // 2 * (ref_w // 2)
    used_rows = text_rows + 1296 + reference_rows
    if (
        refiner != {"name": "refiner", "bounds": [0, text_rows, text_rows]}
        or main != {"name": "main", "bounds": [0, used_rows, ((used_rows + 15) // 16) * 16 + 16]}
        or spec["target_rows"] != 1296
        or spec["vae_reference_size"] != [576, 1024]
        or spec["qwen_reference_size"] != [576, 1024]
        or spec["vae_reference_grid"] != [64, 36]
        or reference_rows != 576
        or spec["vae_reference_rows"] != reference_rows
        or min(ref_h, ref_w) < 2 or (ref_h | ref_w) % 2
        or text_rows <= spec["qwen_image_tokens"] or spec["qwen_image_tokens"] < 1
    ):
        raise ValueError("geometry does not cover the scoped packed edit variants")
    observed = install_cache_trace("warm", root)
    variants = {}
    for variant in (refiner, main):
        bounds = variant["bounds"]
        fused = torch.zeros((bounds[-1], 3 * heads * head_dim), device="cuda", dtype=torch.bfloat16)
        q, k, v = (
            tensor.view(bounds[-1], heads, head_dim)
            for tensor in fused.split(heads * head_dim, dim=-1)
        )
        cu = torch.tensor(bounds, device="cuda", dtype=torch.int32)
        observed.clear()
        result = flash_attn_varlen_func(
            q, k, v, cu_seqlens_q=cu, cu_seqlens_k=cu,
            max_seqlen_q=bounds[1], max_seqlen_k=bounds[1],
            softmax_scale=head_dim**-0.5, causal=False, ver=4,
        )
        torch.cuda.synchronize()
        result = result[0] if isinstance(result, tuple) else result
        if result.shape != q.shape or result.dtype != q.dtype or not torch.isfinite(result).all().item():
            raise RuntimeError(f"invalid native FA4 output for {variant['name']}")
        if not observed:
            raise RuntimeError(f"no persistent FA4 forward key observed for {variant['name']}")
        variants[variant["name"]] = sorted(observed)
        del result, q, k, v, fused, cu

    objects = {}
    for relative in sorted(set().union(*variants.values())):
        path = root / relative
        if not path.is_file() or path.is_symlink() or not path.stat().st_size:
            raise RuntimeError(f"missing or invalid persistent FA4 object: {relative}")
        objects[relative] = {"bytes": path.stat().st_size, "sha256": file_digest(path)}
    proof = {
        "schema": 1, "geometry": spec, "variants": variants, "objects": objects,
        "device": torch.cuda.get_device_name(0),
        "compute_capability": list(torch.cuda.get_device_capability(0)),
    }
    write_json(args.output, proof)
    print("FA4_WARM_PROOF " + json.dumps(proof, sort_keys=True), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    geometry_cli = commands.add_parser("geometry")
    geometry_cli.add_argument("--model-root", required=True)
    geometry_cli.add_argument("--text-encoder-config", default="/models/MiniMax-H3/text_encoder/config.json")
    geometry_cli.add_argument("--sampling", required=True)
    geometry_cli.add_argument("--reference", required=True)
    geometry_cli.add_argument("--output", required=True)
    warm_cli = commands.add_parser("warm")
    warm_cli.add_argument("--geometry", required=True)
    warm_cli.add_argument("--output", required=True)
    args = parser.parse_args()
    (geometry if args.mode == "geometry" else warm)(args)


if __name__ == "__main__":
    main()
