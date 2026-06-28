namespace Ccusage.Api.Dtos;

/// <summary>
/// One typed hit from "Search Everything" (<c>GET /api/search</c>). Every field is already
/// permission-checked + scoped to what the caller may view in its source domain — the search endpoint
/// only ever assembles results the caller could have reached by navigating to the page directly.
/// People are surfaced via display name + AppUser id, never email; sensitive fields (health-log content,
/// finance amounts, location coordinates) are excluded or redacted upstream and never reach a snippet.
/// </summary>
/// <param name="Type">A stable per-row kind token the UI keys an icon/label off (e.g. "recipe", "chat",
/// "note", "list", "meal", "chore", "automation", "bill", "food", "person").</param>
/// <param name="Id">The result's identity WITHIN its domain, as a string (numeric ids stringified, a
/// person is the AppUser id). Combined with <see cref="Domain"/> it's unique; never an email.</param>
/// <param name="Title">The primary line — already display-safe (a person's name is DisplayName.Format'd).</param>
/// <param name="Snippet">A short, sensitive-field-free secondary line (a redacted body excerpt, etc.); may be null.</param>
/// <param name="Subtitle">An optional context line (e.g. the channel name, the list kind); may be null.</param>
/// <param name="DeepLink">An app-relative route that opens the result in its existing page (e.g.
/// "/recipes/12", "/chat?channel=3", "/family/notes#7"). Always starts with '/'.</param>
/// <param name="Domain">The domain bucket this hit belongs to (matches a key in
/// <see cref="SearchResponse.CountsByDomain"/> and the <c>domains</c> filter).</param>
/// <param name="ScoreHint">A coarse relevance hint (higher = stronger), e.g. a title match outranks a
/// body match. Advisory only — the endpoint also returns results domain-grouped.</param>
/// <param name="WhenUtc">An optional timestamp for the row (created/updated), for recency ordering/labels.</param>
public sealed record SearchResultItem(
    string Type,
    string Id,
    string Title,
    string? Snippet,
    string? Subtitle,
    string DeepLink,
    string Domain,
    int ScoreHint,
    DateTime? WhenUtc);

/// <summary>
/// The "Search Everything" response: the echoed query, the unioned + permission-scoped results, a
/// per-domain count (so the UI can render filter chips with totals), and whether any domain hit its
/// per-domain cap (so the UI can hint "refine to see more").
/// </summary>
/// <param name="Query">The normalized query that was run (trimmed).</param>
/// <param name="Results">All hits across every domain the caller could see, capped overall.</param>
/// <param name="CountsByDomain">domain → number of returned results in that domain.</param>
/// <param name="Truncated">True when at least one domain returned its per-domain limit (more may exist).</param>
public sealed record SearchResponse(
    string Query,
    IReadOnlyList<SearchResultItem> Results,
    IReadOnlyDictionary<string, int> CountsByDomain,
    bool Truncated);
