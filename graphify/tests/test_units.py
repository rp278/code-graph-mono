from pathlib import Path

from graphify.extract_units import annotate_units, unit_of


def _tree(tmp_path: Path) -> Path:
    (tmp_path / "apps" / "web").mkdir(parents=True)
    (tmp_path / "apps" / "web" / "Dockerfile").write_text("FROM node")
    (tmp_path / "packages" / "ui").mkdir(parents=True)
    return tmp_path


def test_unit_of(tmp_path):
    root = _tree(tmp_path)
    assert unit_of(root, str(root / "apps/web/src/a.ts")) == "apps/web"
    assert unit_of(root, str(root / "packages/ui/b.ts")) == "packages/ui"
    assert unit_of(root, str(root / "README.md")) is None
    assert unit_of(root, str(root / "apps/loose.ts")) is None  # not inside a unit folder
    assert unit_of(root, "/elsewhere/x.ts") is None


def test_annotate_units(tmp_path):
    root = _tree(tmp_path)
    nodes = [
        {"id": "r::a", "source_file": str(root / "apps/web/src/a.ts")},
        {"id": "r::b", "source_file": str(root / "packages/ui/b.ts")},
        {"id": "r::c", "source_file": str(root / "packages/ui/c.ts")},
    ]
    edges = [
        {"source": "r::a", "target": "r::b", "relation": "imports_from"},
        {"source": "r::a", "target": "r::c", "relation": "imports_from"},
        {"source": "r::b", "target": "r::c", "relation": "imports_from"},  # same unit: ignored
    ]
    unit_nodes, unit_edges = annotate_units("r", root, nodes, edges)
    assert nodes[0]["unit"] == "apps/web" and nodes[0]["unit_kind"] == "app"
    by_label = {n["label"]: n for n in unit_nodes}
    assert by_label["web"]["node_type"] == "app" and by_label["web"]["deployable"] is True
    assert by_label["ui"]["node_type"] == "workspace_package"
    assert len(unit_edges) == 1
    assert unit_edges[0]["import_count"] == 2 and unit_edges[0]["relation"] == "depends_on"


def test_repo_without_units_untouched(tmp_path):
    nodes = [{"id": "r::a", "source_file": str(tmp_path / "src/a.ts")}]
    assert annotate_units("r", tmp_path, nodes, []) == ([], [])
    assert "unit" not in nodes[0]
