using Ccusage.Api.Services;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class PresenceTrackerTests
{
    [Fact]
    public void Touch_makes_a_user_online()
    {
        var t = new PresenceTracker();
        t.Touch("alice@test.local", "Alice", "https://pic/alice.png");

        var online = t.Online();
        online.Should().HaveCount(1);
        online[0].Email.Should().Be("alice@test.local");
        online[0].Name.Should().Be("Alice");
        online[0].Picture.Should().Be("https://pic/alice.png");
    }

    [Fact]
    public void Email_is_lowercased_so_re_touch_collapses_onto_one_entry()
    {
        var t = new PresenceTracker();
        t.Touch("Alice@Test.Local", "Alice", null);
        t.Touch("alice@test.local", "Alice", null);

        var online = t.Online();
        online.Should().HaveCount(1);
        online[0].Email.Should().Be("alice@test.local");
    }

    [Fact]
    public void Online_excludes_an_entry_outside_the_window_and_includes_a_fresh_one()
    {
        var t = new PresenceTracker();
        t.Touch("alice@test.local", "Alice", null);

        // Just-touched entries are within any positive window...
        t.Online(TimeSpan.FromMinutes(2)).Should().ContainSingle(e => e.Email == "alice@test.local");

        // ...but a zero/negative window treats everything (LastSeenUtc < now) as stale.
        t.Online(TimeSpan.Zero).Should().BeEmpty();
    }

    [Fact]
    public void Re_touch_refreshes_name_and_picture()
    {
        var t = new PresenceTracker();
        t.Touch("bob@test.local", "Bob", null);
        t.Touch("bob@test.local", "Bob Smith", "https://pic/bob.png");

        var online = t.Online();
        online.Should().ContainSingle();
        online[0].Name.Should().Be("Bob Smith");
        online[0].Picture.Should().Be("https://pic/bob.png");
    }

    [Fact]
    public void Re_touch_advances_last_seen()
    {
        var t = new PresenceTracker();
        t.Touch("carol@test.local", "Carol", null);
        var first = t.Online().Single().LastSeenUtc;

        t.Touch("carol@test.local", "Carol", null);
        var second = t.Online().Single().LastSeenUtc;

        second.Should().BeOnOrAfter(first);
    }

    [Fact]
    public void Online_is_ordered_by_name()
    {
        var t = new PresenceTracker();
        t.Touch("z@test.local", "Zoe", null);
        t.Touch("a@test.local", "Aaron", null);
        t.Touch("m@test.local", "Mia", null);

        t.Online().Select(e => e.Name).Should().ContainInOrder("Aaron", "Mia", "Zoe");
    }

    [Fact]
    public void Blank_email_is_ignored()
    {
        var t = new PresenceTracker();
        t.Touch("", "Nobody", null);
        t.Touch("   ", "Nobody", null);
        t.Touch(null, "Nobody", null);

        t.Online().Should().BeEmpty();
    }

    [Fact]
    public void Blank_picture_is_normalized_to_null()
    {
        var t = new PresenceTracker();
        t.Touch("dan@test.local", "Dan", "   ");

        t.Online().Single().Picture.Should().BeNull();
    }
}
