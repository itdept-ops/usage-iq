using System.Diagnostics.Metrics;
using System.Threading.Channels;
using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// A bounded in-memory hand-off between the request pipeline and the background writer. The
/// middleware never blocks on the database; if the buffer is full (sustained burst) the newest
/// entries are dropped rather than slowing requests or growing memory without bound.
/// </summary>
public sealed class RequestLogQueue
{
    private const int Capacity = 2000;

    private readonly Channel<RequestLog> _channel = Channel.CreateBounded<RequestLog>(
        new BoundedChannelOptions(Capacity)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
        });

    private static readonly Meter Meter = new("Ccusage.Api.RequestLogQueue");
    private readonly Counter<long> _droppedCounter =
        Meter.CreateCounter<long>("request_log_queue.dropped", unit: "{entry}",
            description: "Request-log entries dropped because the queue was full.");

    private long _dropped;

    public RequestLogQueue()
    {
        Meter.CreateObservableGauge("request_log_queue.depth",
            () => _channel.Reader.Count, unit: "{entry}",
            description: "Current number of buffered request-log entries awaiting the writer.");
        Meter.CreateObservableCounter("request_log_queue.dropped_total",
            () => Interlocked.Read(ref _dropped), unit: "{entry}",
            description: "Total request-log entries dropped because the queue was full.");
    }

    /// <summary>Non-blocking enqueue; returns false if the buffer is full (entry dropped).</summary>
    public bool TryEnqueue(RequestLog entry)
    {
        if (_channel.Writer.TryWrite(entry))
        {
            return true;
        }

        Interlocked.Increment(ref _dropped);
        _droppedCounter.Add(1);
        return false;
    }

    public ChannelReader<RequestLog> Reader => _channel.Reader;
}
