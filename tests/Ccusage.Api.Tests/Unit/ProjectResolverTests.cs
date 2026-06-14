using Ccusage.Api.Ingestion;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class ProjectResolverTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    public void Resolve_returns_unknown_for_null_or_whitespace(string? cwd)
    {
        var (root, name) = ProjectResolver.Resolve(cwd);
        root.Should().Be("(unknown)");
        name.Should().Be("(unknown)");
    }

    [Fact]
    public void Resolve_converts_forward_slashes_to_backslashes()
    {
        var (root, name) = ProjectResolver.Resolve("C:/Users/me/MyRepo");
        root.Should().Be(@"C:\Users\me\MyRepo");
        name.Should().Be("MyRepo");
    }

    [Fact]
    public void Resolve_trims_trailing_slash()
    {
        var (root, name) = ProjectResolver.Resolve(@"C:\Users\me\MyRepo\");
        root.Should().Be(@"C:\Users\me\MyRepo");
        name.Should().Be("MyRepo");
    }

    [Fact]
    public void Resolve_keeps_non_generic_leaf_as_name()
    {
        var (root, name) = ProjectResolver.Resolve(@"C:\code\MyRepo");
        root.Should().Be(@"C:\code\MyRepo");
        name.Should().Be("MyRepo");
    }

    [Fact]
    public void Resolve_collapses_worktree_path_to_parent_repo()
    {
        var (root, name) = ProjectResolver.Resolve(@"C:\code\MyRepo\.claude-worktrees\feature-x");
        root.Should().Be(@"C:\code\MyRepo");
        name.Should().Be("MyRepo");
    }

    [Fact]
    public void Resolve_collapses_worktree_path_arriving_via_forward_slashes()
    {
        var (root, name) = ProjectResolver.Resolve("C:/code/MyRepo/.claude-worktrees/feat");
        root.Should().Be(@"C:\code\MyRepo");
        name.Should().Be("MyRepo");
    }

    [Fact]
    public void Resolve_disambiguates_generic_leaf_using_parent_segment()
    {
        // leaf "Api" is generic, parent is "src" => "src/Api"
        var (root, name) = ProjectResolver.Resolve(@"C:\code\TokenUsage\src\Api");
        root.Should().Be(@"C:\code\TokenUsage\src\Api");
        name.Should().Be("src/Api");
    }

    [Fact]
    public void Resolve_disambiguates_generic_leaf_with_repo_parent()
    {
        // leaf "Api" is generic, parent is "TokenUsage" => "TokenUsage/Api"
        var (root, name) = ProjectResolver.Resolve(@"C:\code\TokenUsage\Api");
        root.Should().Be(@"C:\code\TokenUsage\Api");
        name.Should().Be("TokenUsage/Api");
    }

    [Theory]
    [InlineData(@"C:\code\Repo\api", "Repo/api")]
    [InlineData(@"C:\code\Repo\web", "Repo/web")]
    [InlineData(@"C:\code\Repo\src", "Repo/src")]
    [InlineData(@"C:\code\Repo\app", "Repo/app")]
    [InlineData(@"C:\code\Repo\server", "Repo/server")]
    [InlineData(@"C:\code\Repo\client", "Repo/client")]
    [InlineData(@"C:\code\Repo\backend", "Repo/backend")]
    [InlineData(@"C:\code\Repo\frontend", "Repo/frontend")]
    public void Resolve_treats_all_generic_leaves_with_parent_prefix(string cwd, string expectedName)
    {
        ProjectResolver.Resolve(cwd).Name.Should().Be(expectedName);
    }

    [Fact]
    public void Resolve_matches_generic_leaf_case_insensitively()
    {
        // "API" matches the generic set (OrdinalIgnoreCase) => parent/leaf composition
        var (_, name) = ProjectResolver.Resolve(@"C:\code\TokenUsage\API");
        name.Should().Be("TokenUsage/API");
    }

    [Fact]
    public void Resolve_single_generic_segment_is_not_disambiguated()
    {
        // only one segment, so the (segments.Length >= 2) guard fails => leaf as-is
        var (root, name) = ProjectResolver.Resolve(@"src");
        root.Should().Be("src");
        name.Should().Be("src");
    }

    // TopFolder uses System.IO.Path APIs, so it follows the running platform's path semantics.
    // Build inputs off an absolute base with Path.Combine so these hold on both Windows and Linux CI
    // (hardcoded "C:\..." backslash literals are not valid rooted paths on Linux).
    private static readonly string Base = Path.GetTempPath();

    [Fact]
    public void TopFolder_returns_first_segment_relative_to_root()
    {
        var root = Path.Combine(Base, "root");
        var file = Path.Combine(root, "projA", "sub", "file.jsonl");
        ProjectResolver.TopFolder(file, root).Should().Be("projA");
    }

    [Fact]
    public void TopFolder_returns_file_name_when_directly_under_root()
    {
        var root = Path.Combine(Base, "root");
        var file = Path.Combine(root, "file.jsonl");
        ProjectResolver.TopFolder(file, root).Should().Be("file.jsonl");
    }

    [Fact]
    public void TopFolder_skips_parent_dot_dot_segments()
    {
        // The file is outside the root, so GetRelativePath yields a "../../other/projB/..." path.
        // Only ".." segments are skipped; the first real segment ("other") wins, not "projB".
        var root = Path.Combine(Base, "root", "nested");
        var file = Path.Combine(Base, "other", "projB", "file.jsonl");
        ProjectResolver.TopFolder(file, root).Should().Be("other");
    }
}
