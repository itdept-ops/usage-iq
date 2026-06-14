using System.Text;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// A write-through stream wrapper: forwards every write to the real response stream while keeping
/// a copy of only the first <c>maxCapture</c> bytes (so large responses like CSV exports are never
/// fully buffered) and a running total of bytes written.
/// </summary>
public sealed class CapturingResponseStream(Stream inner, int maxCapture) : Stream
{
    private readonly MemoryStream _capture = new();
    public long TotalBytes { get; private set; }

    private void Capture(ReadOnlySpan<byte> data)
    {
        TotalBytes += data.Length;
        var room = maxCapture - (int)_capture.Length;
        if (room > 0) _capture.Write(data[..Math.Min(room, data.Length)]);
    }

    public string GetCapturedText() => Encoding.UTF8.GetString(_capture.ToArray());

    public override void Write(byte[] buffer, int offset, int count)
    {
        Capture(buffer.AsSpan(offset, count));
        inner.Write(buffer, offset, count);
    }

    public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct)
    {
        Capture(buffer.AsSpan(offset, count));
        await inner.WriteAsync(buffer.AsMemory(offset, count), ct);
    }

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        Capture(buffer.Span);
        await inner.WriteAsync(buffer, ct);
    }

    public override void Flush() => inner.Flush();
    public override Task FlushAsync(CancellationToken ct) => inner.FlushAsync(ct);

    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => inner.Length;
    public override long Position { get => inner.Position; set => inner.Position = value; }
    public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
    public override void SetLength(long value) => inner.SetLength(value);
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    // Dispose only our capture buffer — `inner` is the real response body, owned by the server.
    protected override void Dispose(bool disposing)
    {
        if (disposing) _capture.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await _capture.DisposeAsync();
        await base.DisposeAsync();
    }
}
