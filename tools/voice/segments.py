"""Incremental, bounded speech segments, separate from the original full reply."""
class SentenceBuffer:
    def __init__(self, limit=160, first_limit=80):
        self.limit=limit
        self.first_limit=min(limit, first_limit)
        self.emitted=False
        self.pending=''
    def feed(self, text):
        self.pending += text
        parts=[]
        while self.pending:
            limit=self.limit if self.emitted else self.first_limit
            end=None
            for index,char in enumerate(self.pending[:limit]):
                if char in '。！？；!?;\n' or (char == '.' and index+1 < len(self.pending) and self.pending[index+1].isspace()):
                    end=index+1
                    break
            if end is None and len(self.pending)>=limit:
                end=limit
                # Prefer a nearby word/clause boundary; never discard the tail.
                candidates=[i for i,c in enumerate(self.pending[:limit]) if c in ' ，,'
                            and not (c==',' and i>0 and i+1<len(self.pending)
                                     and self.pending[i-1].isdigit() and self.pending[i+1].isdigit())]
                space=max(candidates,default=-1)
                if space>=limit//2: end=space+1
                # A numeric run such as a decimal or grouped count must not
                # become two spoken numbers just because it crosses the limit.
                while end<len(self.pending) and self.pending[end-1] in '0123456789.,' and self.pending[end] in '0123456789.,':
                    end+=1
                if end==len(self.pending) and self.pending[-1] in '0123456789.,': break
            if end is None: break
            part,self.pending=self.pending[:end],self.pending[end:]
            if part.strip(): parts.append(part); self.emitted=True
        return parts
    def finish(self):
        part,self.pending=self.pending,''
        return [part] if part.strip() else []
