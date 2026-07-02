using System.Diagnostics.Metrics;
using System.Threading.Channels;
using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// A bounded in-memory hand-off between the GeminiService chokepoint and the background writer. The AI
/// path never blocks on the database; if the buffer is full (sustained burst) the newest entries are
/// dropped rather than slowing AI calls or growing memory without bound. Mirrors <see cref="RequestLogQueue"/>.
/// </summary>
public sealed class AiUsageLogQueue
{
    private const int Capacity = 2000;

    private readonly Channel<AiUsageLog> _channel = Channel.CreateBounded<AiUsageLog>(
        new BoundedChannelOptions(Capacity)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
        });

    private static readonly Meter Meter = new("Ccusage.Api.AiUsageLogQueue");
    private readonly Counter<long> _droppedCounter =
        Meter.CreateCounter<long>("ai_usage_log_queue.dropped", unit: "{entry}",
            description: "AI-usage-log entries dropped because the queue was full.");

    private long _dropped;

    public AiUsageLogQueue()
    {
        Meter.CreateObservableGauge("ai_usage_log_queue.depth",
            () => _channel.Reader.Count, unit: "{entry}",
            description: "Current number of buffered AI-usage-log entries awaiting the writer.");
        Meter.CreateObservableCounter("ai_usage_log_queue.dropped_total",
            () => Interlocked.Read(ref _dropped), unit: "{entry}",
            description: "Total AI-usage-log entries dropped because the queue was full.");
    }

    /// <summary>Non-blocking enqueue; returns false if the buffer is full (entry dropped).</summary>
    public bool TryEnqueue(AiUsageLog entry)
    {
        if (_channel.Writer.TryWrite(entry))
        {
            return true;
        }

        Interlocked.Increment(ref _dropped);
        _droppedCounter.Add(1);
        return false;
    }

    /// <summary>Total AI-usage-log entries dropped due to a full queue since process start.</summary>
    public long DroppedCount => Interlocked.Read(ref _dropped);

    public ChannelReader<AiUsageLog> Reader => _channel.Reader;
}
