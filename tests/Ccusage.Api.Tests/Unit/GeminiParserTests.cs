using Ccusage.Api.Ingestion;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class GeminiParserTests
{
    // A realistic Antigravity brain-log path: the conversation id is the segment above .system_generated.
    private const string BrainLogPath =
        "C:/Users/junio/.gemini/antigravity/brain/conv-abc123/.system_generated/logs/transcript.jsonl";
    private const string ConversationId = "conv-abc123";

    private static List<ParsedUsage> Parse(string jsonl, string file = BrainLogPath) =>
        new GeminiParser().Parse(new StringReader(jsonl), file).ToList();

    // One JSONL turn carrying a Gemini-API usageMetadata block + a model id.
    private static string Turn(
        long prompt, long candidates, long cached, long thoughts,
        string model = "gemini-3-pro", string? ts = "2026-06-18T09:30:00Z", string? turnId = null) =>
        "{" +
        "\"model\":\"" + model + "\"," +
        (ts is null ? "" : "\"timestamp\":\"" + ts + "\",") +
        (turnId is null ? "" : "\"turnId\":\"" + turnId + "\",") +
        "\"usageMetadata\":{" +
        "\"promptTokenCount\":" + prompt +
        ",\"candidatesTokenCount\":" + candidates +
        ",\"cachedContentTokenCount\":" + cached +
        ",\"thoughtsTokenCount\":" + thoughts +
        ",\"totalTokenCount\":" + (prompt + candidates + cached + thoughts) +
        "}}";

    [Fact]
    public void Kind_is_gemini()
    {
        new GeminiParser().Kind.Should().Be("gemini");
    }

    // ---- MatchesFile ----

    [Fact]
    public void MatchesFile_true_for_jsonl_name()
    {
        new GeminiParser().MatchesFile("transcript.jsonl").Should().BeTrue();
    }

    [Fact]
    public void MatchesFile_true_for_antigravity_brain_full_path()
    {
        new GeminiParser().MatchesFile(BrainLogPath).Should().BeTrue();
    }

    [Fact]
    public void MatchesFile_true_for_history_json_and_telemetry_log()
    {
        new GeminiParser().MatchesFile("history.json").Should().BeTrue();
        new GeminiParser().MatchesFile("telemetry.log").Should().BeTrue();
    }

    [Fact]
    public void MatchesFile_false_for_unrelated_extension()
    {
        new GeminiParser().MatchesFile("notes.txt").Should().BeFalse();
    }

    // ---- Core mapping (the headline test) ----

    [Fact]
    public void UsageMetadata_line_maps_to_one_row_with_correct_tokens_and_model()
    {
        // prompt->Input, candidates+thoughts->Output, cached->CacheRead, model passthrough.
        var row = Parse(Turn(prompt: 1200, candidates: 400, cached: 300, thoughts: 150)).Single();
        row.Input.Should().Be(1200);
        row.Output.Should().Be(550);      // 400 candidates + 150 thoughts
        row.CacheRead.Should().Be(300);
        row.Cache5m.Should().Be(0);
        row.Cache1h.Should().Be(0);
        row.Model.Should().Be("gemini-3-pro");
        row.SessionId.Should().Be(ConversationId);
        row.IsSidechain.Should().BeFalse();
    }

    [Fact]
    public void Snake_case_usage_metadata_is_also_recognized()
    {
        var line =
            "{\"model\":\"gemini-3\",\"usage_metadata\":{" +
            "\"prompt_token_count\":500,\"candidates_token_count\":100," +
            "\"cached_content_token_count\":50,\"thoughts_token_count\":25}}";
        var row = Parse(line).Single();
        row.Input.Should().Be(500);
        row.Output.Should().Be(125);
        row.CacheRead.Should().Be(50);
        row.Model.Should().Be("gemini-3");
    }

    [Fact]
    public void Usage_nested_deep_in_the_object_is_found_with_nearest_model()
    {
        // The usage block lives several levels down; model sits on an ancestor.
        var line =
            "{\"model\":\"gemini-3-pro\",\"response\":{\"candidates\":[{\"content\":{}}]," +
            "\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":20}}}";
        var row = Parse(line).Single();
        row.Input.Should().Be(10);
        row.Output.Should().Be(20);
        row.Model.Should().Be("gemini-3-pro");
    }

    // ---- Skipping rules ----

    [Fact]
    public void Line_without_any_usage_is_skipped()
    {
        var line = "{\"model\":\"gemini-3-pro\",\"event\":\"thinking\",\"text\":\"hmm\"}";
        Parse(line).Should().BeEmpty();
    }

    [Fact]
    public void Usage_block_with_all_zero_counts_is_skipped()
    {
        Parse(Turn(prompt: 0, candidates: 0, cached: 0, thoughts: 0)).Should().BeEmpty();
    }

    [Fact]
    public void Malformed_json_line_is_skipped_not_thrown()
    {
        var jsonl = "this is not json\n" + Turn(100, 50, 0, 0);
        Parse(jsonl).Should().HaveCount(1);
    }

    [Fact]
    public void Blank_lines_are_skipped()
    {
        var jsonl = "\n" + Turn(100, 50, 0, 0) + "\n";
        Parse(jsonl).Should().HaveCount(1);
    }

    [Fact]
    public void Model_falls_back_to_unknown_when_absent()
    {
        var line = "{\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5}}";
        Parse(line).Single().Model.Should().Be("(unknown)");
    }

    // ---- Dedup key ----

    [Fact]
    public void Dedup_key_uses_conversation_id_and_turn_id_when_present()
    {
        var row = Parse(Turn(100, 50, 0, 0, turnId: "turn-7")).Single();
        row.DedupKey.Should().Be($"gemini|{ConversationId}|turn-7");
    }

    [Fact]
    public void Dedup_key_is_stable_for_the_same_turn_id_across_parses()
    {
        var line = Turn(100, 50, 0, 0, turnId: "turn-7");
        var a = Parse(line).Single().DedupKey;
        var b = Parse(line).Single().DedupKey;
        a.Should().Be(b); // re-ingestion is idempotent
    }

    [Fact]
    public void Dedup_key_falls_back_to_running_index_and_timestamp_without_turn_id()
    {
        var jsonl = Turn(100, 50, 0, 0, turnId: null) + "\n" + Turn(200, 60, 0, 0, turnId: null);
        var rows = Parse(jsonl);
        rows.Should().HaveCount(2);
        rows[0].DedupKey.Should().Be($"gemini|{ConversationId}|1|2026-06-18T09:30:00.0000000Z");
        rows[1].DedupKey.Should().Be($"gemini|{ConversationId}|2|2026-06-18T09:30:00.0000000Z");
        rows[0].DedupKey.Should().NotBe(rows[1].DedupKey);
    }

    // ---- Timestamp ----

    [Fact]
    public void Timestamp_is_parsed_to_utc_when_present_on_the_line()
    {
        Parse(Turn(100, 50, 0, 0, ts: "2026-06-18T09:30:00Z")).Single()
            .TimestampUtc.Should().Be(new DateTime(2026, 6, 18, 9, 30, 0, DateTimeKind.Utc));
    }

    [Fact]
    public void Conversation_id_derives_from_brain_log_path()
    {
        Parse(Turn(100, 50, 0, 0)).Single().SessionId.Should().Be(ConversationId);
    }

    [Fact]
    public void Conversation_id_falls_back_to_filename_for_non_brain_paths()
    {
        Parse(Turn(100, 50, 0, 0), file: "history.jsonl").Single().SessionId.Should().Be("history");
    }
}
