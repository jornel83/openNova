"""Write a first-frame shot config for the OpenNova video tools to stdout."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="准备首帧生成配置，输出可交给 video_validate 或 video_generate。")
    parser.add_argument("--model", choices=("seedance", "veda"), default="seedance",
                        help="默认 Seedance 2.0 Fast，veda 使用 Spark 上的 Minimax H3。")
    parser.add_argument("--first-frame", required=True, help="Seedance 已入库资产 URI，或 Minimax H3 本地 PNG/JPEG 路径。")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--duration", type=int, default=4, help="镜头时长，单位为整秒，默认 4。Minimax H3 支持 4 至 15 秒。")
    args = parser.parse_args()
    config = {"prompt": args.prompt, "duration": args.duration, "ratio": "9:16"}
    if args.model == "seedance":
        if not args.first_frame.startswith("asset://asset-"):
            parser.error("Seedance 首帧需要已入库图片的 asset://asset-... URI。")
        config.update(model="doubao-seedance-2-0-fast-260128", first_frame=args.first_frame)
    else:
        if "://" in args.first_frame:
            parser.error("Minimax H3 首帧需要本地 PNG/JPEG 路径。")
        if not 4 <= args.duration <= 15:
            parser.error("Minimax H3 镜头时长须为 4 至 15 秒的整数。")
        config.update(model="minimax-h3-veda", first_frame_path=str(Path(args.first_frame).expanduser().resolve()))
    print(json.dumps(config, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
