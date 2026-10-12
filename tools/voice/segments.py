"""Incremental, bounded speech segments, separate from the original full reply."""
class SentenceBuffer:
    def __init__(self, limit=160):
        self.limit=limit
        self.pending=''
    def feed(self, text):
        self.pending += text
        parts=[]
        while self.pending:
            end=None
            for index,char in enumerate(self.pending[:self.limit]):
                if char in '。！？；!?;\n' or (char == '.' and index+1 < len(self.pending) and self.pending[index+1].isspace()):
                    end=index+1
                    break
            if end is None and len(self.pending)>=self.limit:
                end=self.limit
                # Prefer a nearby word/clause boundary; never discard the tail.
                space=max(self.pending.rfind(c,0,self.limit) for c in ' ，,')
                if space>=self.limit//2: end=space+1
            if end is None: break
            part,self.pending=self.pending[:end],self.pending[end:]
            if part.strip(): parts.append(part)
        return parts
    def finish(self):
        part,self.pending=self.pending,''
        return [part] if part.strip() else []
