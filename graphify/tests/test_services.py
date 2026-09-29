"""Config-driven service links: ``reached_via`` in the repos file."""
from pathlib import Path

from graphify.extract_services import build_registry, find_service_calls

REPOS = [
    {"name": "ecom-content-stack", "path": "/x",
     "reached_via": {"env": ["CMS_CONTENT_URL"], "url_prefix": "/contentstack/api"}},
    {"name": "plain-repo", "path": "/y"},
]


def test_registry_skips_repos_without_reached_via():
    reg = build_registry(REPOS)
    assert [e["repo"] for e in reg] == ["ecom-content-stack"]
    assert reg[0]["prefix_segs"] == ["contentstack", "api"]


def test_env_var_links_to_declared_repo(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("const u = process.env.CMS_CONTENT_URL + '/entries';\n")
    out = find_service_calls(f, build_registry(REPOS))
    assert out and list(out["services"]) == ["ecom-content-stack"]
    assert out["services"]["ecom-content-stack"] == 1


def test_url_prefix_links_to_declared_repo(tmp_path: Path):
    f = tmp_path / "b.ts"
    f.write_text("\n\nconst d = 'http://host/contentstack/api';\n")
    out = find_service_calls(f, build_registry(REPOS))
    assert out and out["services"] == {"ecom-content-stack": 3}


def test_unrelated_file_has_no_link_and_legacy_rule_still_works(tmp_path: Path):
    f = tmp_path / "c.ts"
    f.write_text("const x = 1;\n")
    assert find_service_calls(f, build_registry(REPOS)) is None
    g = tmp_path / "d.ts"
    g.write_text("fetch(process.env.SELECTION_XAPI_BASE_URL + '/v1/a');\n")
    out = find_service_calls(g, build_registry(REPOS))
    assert out and list(out["services"]) == ["tb-selection-xapi"]
    # and without a registry the legacy rule is unchanged
    assert list(find_service_calls(g)["services"]) == ["tb-selection-xapi"]
