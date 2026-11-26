"""Versioned public contracts. Host identity is deliberately outside tool arguments."""
import math
import os
from pathlib import Path

SPARK_IMAGE_MODEL = 'minimax-h3-image'
SEEDREAM_MODEL = 'doubao-seedream-5-5-261028'
SEEDANCE_MODEL = 'doubao-seedance-2-5-260628'
SCHEMA_VERSION = 2
FORMATS = {'.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif'}
PATH = {'type': 'string', 'minLength': 1, 'maxLength': 4096}
DIMENSION = {'type': 'integer', 'minimum': 1, 'maximum': 4096}


class ContractError(ValueError):
    def __init__(self, code, details=None):
        super().__init__(code)
        self.code = code
        self.details = details or {}


def obj(properties, required):
    return {'type': 'object', 'additionalProperties': False, 'properties': properties, 'required': required}


COMMON = {
    'outputPath': PATH,
    'expectedTarget': {'type': 'string', 'enum': ['absent'], 'default': 'absent'},
}
SCHEMAS = {
    'media_export': obj({
        **COMMON,
        'action': {'type': 'string', 'enum': ['first_frame', 'optimize_gif', 'resize', 'convert_image', 'assemble_frames', 'video_to_gif']},
        'sourcePath': PATH,
        'fixedOverlayPath': {**PATH, 'description': '透明 PNG 固定图层，仅适用于视频转 GIF。'},
        'frames': {'type': 'array', 'minItems': 1, 'maxItems': 256, 'items': obj({
            'path': PATH, 'durationMs': {'type': 'integer', 'minimum': 20, 'maximum': 655350, 'multipleOf': 10},
        }, ['path', 'durationMs'])},
        'outputFormat': {'type': 'string', 'enum': ['png', 'jpeg', 'webp', 'gif']},
        'width': DIMENSION, 'height': DIMENSION,
        'fit': {'type': 'string', 'enum': ['contain', 'cover'], 'default': 'contain'},
        'background': {'type': 'string', 'pattern': '^#[0-9A-Fa-f]{6}$'},
        'quality': {'type': 'integer', 'minimum': 1, 'maximum': 100},
        'colors': {'type': 'integer', 'minimum': 2, 'maximum': 256},
        'loop': {'type': 'integer', 'minimum': 0, 'maximum': 65535},
        'maxBytes': {'type': 'integer', 'minimum': 1, 'maximum': 67108864},
        'fps': {'type': 'integer', 'enum': [5, 10, 20, 25], 'default': 10},
        'startMs': {'type': 'integer', 'minimum': 0, 'maximum': 3600000, 'default': 0},
        'durationMs': {'type': 'integer', 'minimum': 1, 'maximum': 10000, 'default': 4000},
    }, ['action', 'outputPath']),
    'image_generate': obj({
        **COMMON,
        'mode': {'type': 'string', 'enum': ['create', 'edit']},
        'prompt': {'type': 'string', 'minLength': 1, 'maxLength': 32000},
        'references': {'type': 'array', 'maxItems': 10, 'items': PATH},
        'provider': {'type': 'string', 'enum': ['ark', 'spark'], 'default': 'ark',
                     'description': '默认使用方舟；指定 Minimax H3 Image 时可省略 provider。'},
        'model': {'type': 'string', 'enum': [SEEDREAM_MODEL, SPARK_IMAGE_MODEL], 'default': SEEDREAM_MODEL,
                  'description': '默认 Seedream 5.5。Spark 上的 minimax-h3-image 支持方形文生图、单张方图或 9:16 竖屏参考图编辑。'},
        'outputFormat': {'type': 'string', 'enum': ['png', 'jpeg', 'webp']},
        'width': DIMENSION, 'height': DIMENSION,
        'size': {'type': 'string', 'pattern': r'^(1K|1\.5K|2K|[0-9]{3,5}x[0-9]{3,5})$',
                 'description': '模型原始生成尺寸。Spark 文生图和方图编辑为 2048x2048，9:16 参考图编辑为 864x1536。省略时按参考图比例选择。width/height 为本地交付尺寸。'},
        'watermark': {'type': 'boolean'},
    }, ['mode', 'prompt', 'outputPath']),
    'gif_generate': obj({
        'sourcePath': {**PATH, 'description': '已确认的项目内静态图；对话中可沿用当前图片。'},
        'outputDir': {**PATH, 'description': '项目内尚不存在的新版本目录，父目录必须存在。'},
        'fixedOverlayPath': {**PATH, 'description': '可选的透明 PNG 固定图层，逐帧在本地合成；指定时同时填写 GIF 宽高。'},
        'motionReferencePath': {**PATH, 'description': '可选的干净首帧，例如去除固定文字后的静态图；需搭配固定图层。'},
        'motion': {'type': 'string', 'minLength': 1, 'maxLength': 32000},
        'provider': {'type': 'string', 'enum': ['ark'], 'default': 'ark'},
        'mode': {'type': 'string', 'enum': ['auto', 'video'], 'default': 'video',
                 'description': 'Seedance先生成视频，再在本地转换GIF；auto当前也只选择video，不调用原生GIF接口。'},
        'model': {'type': 'string', 'enum': [SEEDANCE_MODEL], 'default': SEEDANCE_MODEL,
                  'description': '通常省略，由执行器使用已验证的 Seedance 2.5。'},
        'durationSeconds': {'type': 'integer', 'minimum': 4, 'maximum': 10, 'default': 4},
        'videoResolution': {'type': 'string', 'enum': ['480p', '720p', '1080p'], 'default': '480p'},
        'fps': {'type': 'integer', 'enum': [5, 10, 20, 25], 'default': 10},
        'maxBytes': {'type': 'integer', 'minimum': 1, 'maximum': 20971520},
        'loop': {'type': 'integer', 'minimum': 0, 'maximum': 65535, 'default': 0},
        'width': DIMENSION, 'height': DIMENSION,
        'expectedTarget': COMMON['expectedTarget'],
    }, ['sourcePath', 'outputDir', 'motion']),
}


def validate(value, schema, field='arguments'):
    import re
    kind = schema.get('type')
    valid = {'object': isinstance(value, dict), 'array': isinstance(value, list),
             'string': isinstance(value, str), 'integer': type(value) is int,
             'boolean': type(value) is bool}.get(kind, True)
    if not valid:
        raise ContractError('invalid_arguments', {'field': field, 'expected': kind})
    if kind == 'object':
        extra = set(value) - set(schema['properties'])
        missing = set(schema.get('required', [])) - set(value)
        if extra or missing:
            raise ContractError('invalid_arguments', {'field': field, 'unknown': sorted(extra), 'missing': sorted(missing)})
        for name, item in value.items():
            validate(item, schema['properties'][name], field + '.' + name)
    elif kind == 'array':
        if not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', math.inf):
            raise ContractError('invalid_arguments', {'field': field})
        for i, item in enumerate(value):
            validate(item, schema['items'], f'{field}[{i}]')
    elif kind == 'string':
        if '\0' in value or not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', math.inf):
            raise ContractError('invalid_arguments', {'field': field})
        if 'pattern' in schema and not re.fullmatch(schema['pattern'], value):
            raise ContractError('invalid_arguments', {'field': field})
    elif kind == 'integer':
        if not schema.get('minimum', -math.inf) <= value <= schema.get('maximum', math.inf):
            raise ContractError('invalid_arguments', {'field': field})
        if value % schema.get('multipleOf', 1):
            raise ContractError('invalid_arguments', {'field': field})
    if 'enum' in schema and value not in schema['enum']:
        raise ContractError('invalid_arguments', {'field': field})


def absolute_path(path, base_dir):
    # Lexical identity stays stable when an input is edited or removed after capture.
    return os.path.abspath(os.path.join(str(base_dir), path))


def normalize(name, arguments, base_dir):
    if name not in SCHEMAS:
        raise ContractError('unknown_media_tool')
    validate(arguments, SCHEMAS[name])
    result = dict(arguments)
    if ('width' in result) != ('height' in result):
        raise ContractError('dimensions_must_be_paired')
    for key in ('sourcePath', 'outputPath', 'outputDir', 'fixedOverlayPath', 'motionReferencePath'):
        if key in result:
            result[key] = absolute_path(result[key], base_dir)
    result['expectedTarget'] = 'absent'
    if name != 'media_export':
        if name == 'image_generate':
            provider = result.setdefault('provider', 'spark' if result.get('model') == SPARK_IMAGE_MODEL else 'ark')
            model = result.setdefault('model', SPARK_IMAGE_MODEL if provider == 'spark' else SEEDREAM_MODEL)
            if (provider == 'spark') != (model == SPARK_IMAGE_MODEL):
                raise ContractError('image_provider_model_mismatch')
        else:
            result.setdefault('provider', 'ark')
        if name == 'gif_generate':
            result.setdefault('mode', 'video')
            if 'motionReferencePath' in result and 'fixedOverlayPath' not in result:
                raise ContractError('motion_reference_requires_fixed_overlay')
            if 'fixedOverlayPath' in result and 'width' not in result:
                raise ContractError('fixed_overlay_dimensions_required')
        if name == 'image_generate' and result['mode'] == 'edit' and not result.get('references'):
            raise ContractError('edit_reference_required')
        if 'references' in result:
            result['references'] = [absolute_path(p, base_dir) for p in result['references']]
        return result
    action = result['action']
    if 'fixedOverlayPath' in result and action != 'video_to_gif':
        raise ContractError('fixed_overlay_requires_video_to_gif')
    if action == 'assemble_frames':
        if not result.get('frames') or 'sourcePath' in result:
            raise ContractError('frame_inputs_required')
        result['frames'] = [{**f, 'path': absolute_path(f['path'], base_dir)} for f in result['frames']]
    elif 'sourcePath' not in result or 'frames' in result:
        raise ContractError('source_input_required')
    extension = FORMATS.get(Path(result['outputPath']).suffix.lower())
    if not extension or result.get('outputFormat', extension) != extension:
        raise ContractError('output_format_mismatch')
    result['outputFormat'] = extension
    if action == 'first_frame' and extension != 'png':
        raise ContractError('first_frame_requires_png')
    if action in ('optimize_gif', 'assemble_frames', 'video_to_gif') and extension != 'gif':
        raise ContractError('gif_output_required')
    if action != 'video_to_gif' and any(k in result for k in ('fps', 'startMs', 'durationMs')):
        raise ContractError('video_parameter_requires_video_to_gif')
    if action == 'video_to_gif' and Path(result['sourcePath']).suffix.lower() not in ('.mp4', '.mov'):
        raise ContractError('video_source_required')
    if action == 'convert_image' and extension == 'gif':
        raise ContractError('static_format_required')
    if action == 'resize' and 'width' not in result:
        raise ContractError('dimensions_required')
    if action in ('first_frame', 'convert_image') and ('width' in result or 'fit' in result):
        raise ContractError('resize_action_required')
    if extension != 'gif' and any(k in result for k in ('loop', 'colors')):
        raise ContractError('gif_parameter_requires_gif')
    if 'width' in result:
        result.setdefault('fit', 'contain')
    return result


def tool_definitions():
    descriptions = {
        'image_generate': '默认用 Seedream 5.5，根据提示词生成图片或参考项目内图片改稿。选择 minimax-h3-image 可在 Spark 上生成。',
        'gif_generate': '使用 Seedance 2.5 根据已确认的图片生成视频，在项目内的新版本目录保存源 MP4、GIF 和实际首帧 PNG。',
        'media_export': '本地提取首帧、压缩GIF、缩放、静态格式转换、合成帧或视频转GIF；不调用生成模型。',
    }
    return [{'type': 'function', 'function': {'name': name, 'description': descriptions[name], 'parameters': SCHEMAS[name]}}
            for name in ('image_generate', 'gif_generate', 'media_export')]
