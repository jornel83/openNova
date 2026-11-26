"""Exercise Spark through the public operation, with no network or GPU."""
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image
from tools.image.providers import ark_provider, spark_provider as spark
from tools.image.schema import ContractError
from tools.image.tool import invoke


class SparkImageTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.workspace = self.base / "project"
        self.workspace.mkdir()
        self.host = dict(base_dir=self.workspace, state_dir=self.base / "state", operation_id="image-test",
                         binding={"projectId": "project", "requestId": "request"})
        self.args = dict(model="minimax-h3-image", mode="create", prompt="a blue cup", outputPath="cup.png")
        self.original_key = patch.object(ark_provider, "resolve_credential", side_effect=AssertionError("Ark key used"))
        self.original_key.start()
        self.addCleanup(self.original_key.stop)
        self.submits, self.polls, self.downloads = 0, 0, 0
        self.lose_submit = self.lose_download = False
        self.response = {}
        for method in ("submit", "status", "download"):
            mock = patch.object(spark, method, getattr(self, method))
            mock.start()
            self.addCleanup(mock.stop)

    def call(self, **extras):
        return invoke("image_generate", self.args, **self.host, **extras)

    def submit(self, host, task_id, mode, prompt, reference):
        self.submits += 1
        self.hostname = host
        self.reference = reference
        self.response = dict(id=task_id, mode=mode, status="queued",
                             promptSha256=hashlib.sha256(prompt.encode()).hexdigest(),
                             referenceSha256=hashlib.sha256(reference).hexdigest() if reference else None)
        output = BytesIO()
        native = spark.SQUARE
        if reference is not None:
            with Image.open(BytesIO(reference)) as ref:
                native = spark.PORTRAIT if ref.width < ref.height else spark.SQUARE
        Image.new("RGB", spark.NATIVE_SIZES[native], "navy").save(output, "PNG")
        self.image = output.getvalue()
        if self.lose_submit:
            raise OSError("lost the submit reply")
        return self.response

    def status(self, host, task_id):
        self.polls += 1
        self.assertEqual(self.hostname, host)
        self.assertEqual(self.response["id"], task_id)
        return self.response

    def download(self, host, task_id, destination, size):
        self.downloads += 1
        self.assertEqual(self.response["id"], task_id)
        self.assertEqual(size, len(self.image))
        if self.lose_download:
            destination.write_bytes(self.image[:20])
            raise OSError("lost SSH")
        destination.write_bytes(self.image)

    def finish_remote(self):
        self.response.update(status="succeeded", sha256=hashlib.sha256(self.image).hexdigest(), bytes=len(self.image))

    def test_square_create_resumes_by_id_even_if_ssh_or_host_configuration_changes(self):
        self.lose_submit = True
        with patch.dict(os.environ, OPENNOVA_SPARK_SSH_HOST="first-gpu"):
            first = self.call()
        self.assertEqual(first["status"], "pending")
        self.assertRegex(first["generation"]["taskId"], r'^h3-image-[a-f0-9]{32}$')
        self.assertFalse((self.workspace / "cup.png").exists())
        with patch.dict(os.environ, OPENNOVA_SPARK_SSH_HOST="another-gpu"):
            queued = self.call(recover_only=True)
            self.assertEqual(queued["generation"]["status"], "queued")
            self.finish_remote()
            self.lose_download = True
            interrupted = self.call(recover_only=True)
            self.assertEqual(interrupted["error"]["code"], "spark_image_download_pending")
            self.lose_download = False
            final = self.call(recover_only=True)
        self.assertEqual(final["status"], "completed", final)
        self.assertEqual(final["generation"]["provider"], "spark")
        self.assertEqual(final["generation"]["taskId"], first["generation"]["taskId"])
        self.assertEqual(final["artifact"]["width"], 2048)
        self.assertEqual(final["generation"]["sourceArtifact"]["sha256"], self.response["sha256"])
        self.assertEqual(self.call(), final)
        self.assertEqual((self.submits, self.polls, self.downloads), (1, 3, 2))

    def test_portrait_edit_keeps_exact_native_reference_and_delivers_requested_size(self):
        ref = self.workspace / "ref.png"
        Image.new("RGB", (720, 1280), "white").save(ref)
        self.args = dict(provider="spark", mode="edit", prompt="add two small strips of tape", references=[str(ref)],
                         outputPath="tape.jpg", width=432, height=768)
        first = self.call()
        self.assertEqual(first["status"], "pending")
        self.assertEqual(ref.read_bytes(), self.reference)
        ref.unlink()
        self.finish_remote()
        final = self.call(recover_only=True)
        self.assertEqual(final["status"], "completed", final)
        self.assertEqual([final["artifact"][k] for k in ("format", "width", "height")], ["jpeg", 432, 768])
        self.assertEqual([final["generation"]["sourceArtifact"][k] for k in ("width", "height")], [864, 1536])

    def test_bad_model_reference_size_and_provider_are_rejected_before_submission(self):
        bad = ({"provider": "ark"}, {"references": ["x.png"]}, {"watermark": True},
               {"size": "1K"}, {"mode": "edit", "references": ["a.png", "b.png"]})
        create = dict(self.args)
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ContractError):
                self.args = dict(create, **change)
                self.call()
        self.args = dict(create, mode="edit", references=["wide.jpg"])
        Image.new("RGB", (1024, 512)).save(self.workspace / "wide.jpg")
        self.assertEqual(self.call()["error"]["code"], "unsupported_spark_reference_aspect_ratio")
        self.assertEqual(self.submits, 0)

    def test_square_edit_resolves_native_size_before_submission(self):
        Image.new("RGB", (512, 512)).save(self.workspace / "square.jpg")
        self.args.update(mode="edit", references=["square.jpg"])
        first = self.call()
        self.assertEqual(first["generation"]["size"], spark.SQUARE)
        with Image.open(BytesIO(self.reference)) as ref:
            self.assertEqual(ref.size, (1024, 1024))
        self.finish_remote()
        stored = json.loads((self.base / "state/image-test/operation.json").read_text())["request"]
        recovered = invoke("image_generate", stored, **self.host, recover_only=True)
        self.assertEqual(recovered["artifact"]["width"], 2048)
        self.host["operation_id"] = "conflicting-square"
        self.args.update(size=spark.PORTRAIT, outputPath="another.png")
        self.assertEqual(self.call()["error"]["code"], "spark_reference_size_mismatch")
        self.assertEqual(self.submits, 1)

    def test_missing_accepted_job_is_unknown_and_not_reissued(self):
        self.call()
        self.response.update(status="missing")
        unknown = self.call(recover_only=True)
        self.assertEqual(unknown["status"], "unknown")
        self.assertEqual(self.call(), unknown)
        self.assertEqual(self.submits, 1)

    def test_mismatched_remote_artifact_is_not_published(self):
        self.call()
        self.finish_remote()
        self.response["sha256"] = "f" * 64
        self.assertEqual(self.call()["error"]["code"], "spark_image_output_mismatch")
        self.assertFalse((self.workspace / "cup.png").exists())

    def test_uncertain_reservation_is_recovered_without_a_second_submit(self):
        class Crash(BaseException):
            pass
        def interrupt(phase):
            if phase == "after_reserve":
                raise Crash
        with self.assertRaises(Crash):
            self.call(hook=interrupt)
        record = json.loads((self.base / "state/image-test/operation.json").read_text())
        self.assertEqual(record["stage"], "submitting_spark")
        self.hostname = record["sparkHost"]
        self.response = {"id": record["generation"]["taskId"], "status": "missing"}
        self.assertEqual(self.call(recover_only=True)["status"], "unknown")
        self.assertEqual(self.submits, 0)


class SparkWorkerTest(unittest.TestCase):
    def test_packaged_job_detaches_and_exposes_the_verified_result(self):
        task_id = "h3-image-" + "a" * 32
        prompt = "贴布 '$(ignored)'\nsecond line"
        ref = b"frozen reference bytes"
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp) / task_id
            job_dir.mkdir()
            with patch.object(spark, "_ssh") as ssh:
                spark.submit("host", task_id, "edit", prompt, ref)
            host, command, payload = ssh.call_args.args
            self.assertEqual(host, "host")
            self.assertNotIn(prompt, command)
            with tarfile.open(fileobj=BytesIO(payload)) as archive:
                self.assertEqual(set(archive.getnames()),
                                 {"worker.py", "prompt.txt", "reference.png", "job.json"} |
                                 {"profile/" + name for name in spark.PROFILE})
                for member in archive:
                    path = job_dir / member.name
                    path.parent.mkdir(exist_ok=True)
                    path.write_bytes(archive.extractfile(member).read())
            self.assertEqual((job_dir / "prompt.txt").read_text(), prompt)
            self.assertEqual((job_dir / "reference.png").read_bytes(), ref)
            # Substitute only the GPU inference call; exercise the packaged supervisor and its real lease.
            (job_dir / "profile/generate.py").write_text(
                "from pathlib import Path\nimport time\n"
                "def run(job_id, prompt, reference, on_running):\n"
                "    on_running()\n"
                "    for _ in range(100):\n"
                "        if Path('release').exists(): break\n"
                "        time.sleep(0.05)\n"
                "    return reference\n")

            def worker(action):
                return json.loads(subprocess.check_output(
                    [sys.executable, "-B", "worker.py", action], cwd=job_dir, timeout=5))

            self.assertEqual(worker("start")["status"], "queued")
            deadline = time.monotonic() + 5
            state = worker("status")
            while state["status"] == "queued" and time.monotonic() < deadline:
                time.sleep(.02)
                state = worker("status")
            self.assertEqual(state["status"], "running", state)
            (job_dir / "release").touch()
            while state["status"] == "running" and time.monotonic() < deadline:
                time.sleep(.02)
                state = worker("status")
            self.assertEqual(state["status"], "succeeded", state)
            self.assertEqual(state["sha256"], hashlib.sha256(ref).hexdigest())
            self.assertEqual((job_dir / "output.png").read_bytes(), ref)


if __name__ == "__main__":
    unittest.main()
