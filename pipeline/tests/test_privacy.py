import json
import tempfile
import unittest
from pathlib import Path

from pipeline import privacy
from pipeline.tests.helpers import synthetic_panel


class TestPrivacy(unittest.TestCase):
    def test_forbidden_key_and_single_stock_series(self):
        panel = synthetic_panel(n_stocks=5, n_months=30)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / "strategies").mkdir()
            months = [str(m) for m in panel.months]
            stock = [None if v != v else float(v) for v in panel.r_val["S002"]]
            obj = {"months": months, "freqs": {"M": {"GMV": {"gross": stock, "n_pos": [1] * 30}}}}
            (out / "strategies" / "x.json").write_text(json.dumps(obj))
            (out / "market.json").write_text(json.dumps({"close": [1, 2]}))
            (out / "leak.csv").write_text("x")
            rep = privacy.check_outputs(out, panel)
            self.assertEqual(rep["status"], "failed")
            text = " ".join(rep["problems"])
            self.assertIn("forbidden key 'close'", text)
            self.assertIn("unexpected file leak.csv", text)
            self.assertIn("equals the return of S002", text)

    def test_clean_output(self):
        panel = synthetic_panel(n_stocks=5, n_months=30)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / "strategies").mkdir()
            avg = panel.r_val.mean(axis=1)
            obj = {"months": [str(m) for m in panel.months],
                   "freqs": {"M": {"EW": {"gross": [None if v != v else float(v) for v in avg], "n_pos": [5] * 30}}}}
            (out / "strategies" / "x.json").write_text(json.dumps(obj))
            self.assertEqual(privacy.check_outputs(out, panel)["status"], "ok")


if __name__ == "__main__":
    unittest.main()
