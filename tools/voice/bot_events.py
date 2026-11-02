"""Cancellable loopback POST-SSE transport; never follows redirects or proxies."""
import asyncio
import codecs
import json


async def read_events(port, token, cursor):
    reader, writer = await asyncio.wait_for(asyncio.open_connection('127.0.0.1', port, limit=65536), 5)
    try:
        body = json.dumps({'cursor':cursor}).encode()
        headers = (f'POST /events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
                   f'Authorization: Bearer {token}\r\nContent-Type: application/json\r\n'
                   f'Accept: text/event-stream\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n')
        writer.write(headers.encode()+body)
        await writer.drain()
        raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
        if len(raw)>16384: raise ValueError('event_headers_too_large')
        lines = raw.decode('iso-8859-1').split('\r\n')
        status = int(lines[0].split(' ', 2)[1])
        fields = dict(line.split(':',1) for line in lines[1:] if ':' in line)
        fields = {key.lower():value.strip().lower() for key,value in fields.items()}
        if status != 200:
            raise ConnectionError('cursor_reset' if status==409 else 'event_stream_unavailable')
        if not fields.get('content-type','').startswith('text/event-stream'):
            raise ValueError('invalid_event_stream')
        chunked = fields.get('transfer-encoding')=='chunked'
        decoder = codecs.getincrementaldecoder('utf-8')()
        pending = ''
        while True:
            if chunked:
                line = await asyncio.wait_for(reader.readline(), 35)
                if not line: raise ConnectionError('event_stream_closed')
                size = int(line.split(b';',1)[0].strip(), 16)
                if size<0 or size>2*1024*1024: raise ValueError('event_frame_too_large')
                if not size: raise ConnectionError('event_stream_closed')
                chunk = await asyncio.wait_for(reader.readexactly(size+2), 35)
                if chunk[-2:]!=b'\r\n': raise ValueError('invalid_event_chunk')
                chunk = chunk[:-2]
            else:
                chunk = await asyncio.wait_for(reader.read(65536), 35)
                if not chunk: raise ConnectionError('event_stream_closed')
            pending += decoder.decode(chunk)
            if len(pending)>2*1024*1024: raise ValueError('event_frame_too_large')
            while '\n\n' in pending:
                frame,pending = pending.split('\n\n',1)
                data = '\n'.join(line[5:].lstrip() for line in frame.splitlines() if line.startswith('data:'))
                if data: yield json.loads(data)
    finally:
        writer.close()
        try: await asyncio.wait_for(writer.wait_closed(), 1)
        except (OSError, asyncio.TimeoutError): pass
