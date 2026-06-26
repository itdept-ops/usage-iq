using System.Globalization;
using Ccusage.Api.Dtos;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using MigraDoc.DocumentObjectModel;
using MigraDoc.Rendering;
using PdfSharp.Fonts;
using Color = MigraDoc.DocumentObjectModel.Color;
using Document = MigraDoc.DocumentObjectModel.Document;
using Border = MigraDoc.DocumentObjectModel.Border;
using VerticalAlignment = MigraDoc.DocumentObjectModel.Tables.VerticalAlignment;
using Paragraph = DocumentFormat.OpenXml.Wordprocessing.Paragraph;
using Text = DocumentFormat.OpenXml.Wordprocessing.Text;
using Shading = DocumentFormat.OpenXml.Wordprocessing.Shading;
using DW = DocumentFormat.OpenXml.Wordprocessing;
using A = DocumentFormat.OpenXml.Drawing;
using DRAW = DocumentFormat.OpenXml.Drawing;
using PIC = DocumentFormat.OpenXml.Drawing.Pictures;
using WP = DocumentFormat.OpenXml.Drawing.Wordprocessing;

namespace Ccusage.Api.Services;

/// <summary>
/// Renders a structured <see cref="ResumeDataDto"/> (and cover letters) into downloadable PDF and DOCX bytes.
/// This is the doc-generation half of the Resume Builder: the endpoint layer hands it the resume data, an
/// optional headshot, and a style flag, and gets back a finished file to stream.
///
/// <para>TWO resume styles, both rendering every non-empty <see cref="ResumeDataDto"/> section and nothing it
/// doesn't have:</para>
/// <list type="bullet">
///   <item><b>ATS-plain</b> (<c>designed: false</c>) — a single-column, photo-free, machine-parseable layout:
///   the name + a one-line contact string at the top, then standard UPPERCASE section headings
///   (SUMMARY / EXPERIENCE / EDUCATION / SKILLS / PROJECTS / CERTIFICATIONS) with plain bullets. Built to sail
///   through resume-screening parsers.</item>
///   <item><b>Designed</b> (<c>designed: true</c>) — a polished layout with a tasteful accent-color header band
///   (name + headline + contact), the headshot embedded in the header when supplied, and accent-ruled section
///   headings. Still truthful: it only renders what's in the data.</item>
/// </list>
///
/// <para>CROSS-PLATFORM FONTS — PDFsharp 6.x core ships no GDI/System.Drawing on Linux, so it cannot discover
/// system fonts; left alone it throws the first time it needs a glyph. We register a one-time
/// <see cref="IFontResolver"/> (<see cref="LatoFontResolver"/>) that serves the bundled Lato Regular/Bold TTFs
/// (copied next to the dll by the csproj) for the single family <c>"Lato"</c>. MigraDoc styles everything in
/// that family, so PDF generation never reaches the system-font path. The DOCX path uses no fonts at render
/// time (Word resolves "Lato" itself when the file is opened), so it needs no resolver.</para>
///
/// <para>HEADSHOT — bytes + MIME come straight off the master <c>Resume</c>. In the PDF path the bytes are
/// wrapped in an <c>ImageSource</c> (PDFsharp's in-memory image API) so nothing touches disk; in the DOCX path
/// they are added as an <see cref="ImagePart"/> of the matching content type. Both embed JPEG and PNG. A
/// missing/zero-length/undecodable headshot is silently skipped — doc gen never throws on a bad image.</para>
/// </summary>
public sealed class ResumeDocumentService
{
    // ----- palette (kept subtle; the designed style only) -----
    private static readonly Color AccentColor = Color.FromRgb(0x1F, 0x3A, 0x5F);   // deep slate-navy
    private static readonly Color AccentText = Color.FromRgb(0xFF, 0xFF, 0xFF);
    private static readonly Color MutedColor = Color.FromRgb(0x55, 0x5B, 0x66);
    private static readonly Color RuleColor = Color.FromRgb(0xC9, 0xCF, 0xD8);
    private const string FontFamily = "Lato";

    static ResumeDocumentService() => LatoFontResolver.EnsureRegistered();

    // ===========================================================================================
    // PDF (MigraDoc → PDFsharp)
    // ===========================================================================================

    /// <summary>Render a resume to PDF. <paramref name="designed"/> selects the polished vs. ATS-plain layout;
    /// the headshot (decoded via <paramref name="headshotMime"/>) is embedded only in the designed header and
    /// only when present and decodable.
    ///
    /// <para>MigraDoc 6.2.4's <c>AddImage</c> only accepts a FILE PATH (the in-memory <c>ImageSource</c> API of
    /// older builds is gone), so a supplied headshot is written to a short-lived temp file for the duration of
    /// the render and deleted in a <c>finally</c>. The temp file never outlives this call.</para></summary>
    public byte[] BuildResumePdf(ResumeDataDto data, bool designed, byte[]? headshot, string? headshotMime)
    {
        data ??= ResumeDataDto.Empty;
        var doc = NewDocument();
        var section = doc.AddSection();
        ConfigurePage(section, designed);

        string? tempImage = null;
        try
        {
            if (designed)
            {
                tempImage = TryWriteTempImage(headshot, headshotMime);
                RenderDesignedHeaderPdf(section, data.Contact, tempImage);
            }
            else
            {
                RenderPlainHeaderPdf(section, data.Contact);
            }

            RenderBodyPdf(section, data, designed);
            return RenderPdf(doc);
        }
        finally
        {
            if (tempImage is not null)
                TryDeleteTemp(tempImage);
        }
    }

    /// <summary>Render a cover letter to PDF as a clean business letter: the sender block from
    /// <paramref name="contact"/>, the date, then the body paragraphs (blank-line separated).</summary>
    public byte[] BuildCoverLetterPdf(string coverLetter, ResumeContactDto contact)
    {
        contact ??= ResumeDataDto.Empty.Contact;
        var doc = NewDocument();
        var section = doc.AddSection();
        ConfigurePage(section, designed: false);

        // Sender block
        AddText(section, contact.FullName, bold: true, size: 13);
        foreach (var line in SenderLines(contact))
            AddText(section, line, size: 10, color: MutedColor);

        AddSpacer(section, 12);
        AddText(section, DateTime.Now.ToString("MMMM d, yyyy", CultureInfo.InvariantCulture), size: 10.5);
        AddSpacer(section, 10);

        foreach (var para in Paragraphs(coverLetter))
        {
            var p = section.AddParagraph(para);
            p.Format.Font.Name = FontFamily;
            p.Format.Font.Size = 10.5;
            p.Format.SpaceAfter = 8;
            p.Format.Alignment = ParagraphAlignment.Justify;
        }
        return RenderPdf(doc);
    }

    // ---- PDF building blocks --------------------------------------------------------------------

    private static Document NewDocument()
    {
        var doc = new Document();
        var normal = doc.Styles[StyleNames.Normal]!;
        normal.Font.Name = FontFamily;
        normal.Font.Size = 10;
        return doc;
    }

    private static void ConfigurePage(Section section, bool designed)
    {
        var ps = section.PageSetup;
        ps.PageFormat = PageFormat.Letter;
        ps.TopMargin = designed ? Unit.FromPoint(0) : Unit.FromCentimeter(1.6);
        ps.BottomMargin = Unit.FromCentimeter(1.4);
        ps.LeftMargin = Unit.FromCentimeter(designed ? 1.9 : 1.7);
        ps.RightMargin = Unit.FromCentimeter(designed ? 1.9 : 1.7);
    }

    /// <summary>Designed header: a full-bleed accent band holding the name, headline, and one-line contact on
    /// the left, with the headshot (when present) on the right. Built as a borderless 2-column table shaded in
    /// the accent color so it spans the page edge-to-edge above the body margins.</summary>
    private static void RenderDesignedHeaderPdf(Section section, ResumeContactDto contact, string? imagePath)
    {
        var pageWidth = section.PageSetup.PageWidth;
        var table = section.AddTable();
        table.Borders.Width = 0;
        table.Shading.Color = AccentColor;

        var hasPhoto = imagePath is not null;
        var photoWidth = Unit.FromCentimeter(hasPhoto ? 3.2 : 0);
        var textWidth = pageWidth - photoWidth;

        table.AddColumn(textWidth);
        if (hasPhoto) table.AddColumn(photoWidth);

        var row = table.AddRow();
        row.VerticalAlignment = VerticalAlignment.Center;

        // Left: name / headline / contact, padded in from the page edge.
        var textCell = row.Cells[0];
        textCell.Format.LeftIndent = Unit.FromCentimeter(1.9);
        textCell.Format.RightIndent = Unit.FromCentimeter(0.6);
        var pad = textCell.AddParagraph();
        pad.Format.SpaceBefore = Unit.FromCentimeter(0.7);
        pad.Format.LineSpacingRule = LineSpacingRule.Single;

        var name = textCell.AddParagraph(Safe(contact.FullName, "Your Name"));
        name.Format.Font.Size = 22;
        name.Format.Font.Bold = true;
        name.Format.Font.Color = AccentText;
        name.Format.SpaceAfter = 1;

        if (!string.IsNullOrWhiteSpace(contact.Headline))
        {
            var head = textCell.AddParagraph(contact.Headline.Trim());
            head.Format.Font.Size = 11.5;
            head.Format.Font.Color = AccentText;
            head.Format.SpaceAfter = 3;
        }

        var contactLine = ContactLine(contact);
        if (!string.IsNullOrWhiteSpace(contactLine))
        {
            var c = textCell.AddParagraph(contactLine);
            c.Format.Font.Size = 9;
            c.Format.Font.Color = AccentText;
        }
        var bottomPad = textCell.AddParagraph();
        bottomPad.Format.SpaceAfter = Unit.FromCentimeter(0.7);

        // Right: headshot.
        if (hasPhoto)
        {
            var photoCell = row.Cells[1];
            photoCell.Format.Alignment = ParagraphAlignment.Center;
            var p = photoCell.AddParagraph();
            p.Format.SpaceBefore = Unit.FromCentimeter(0.6);
            p.Format.SpaceAfter = Unit.FromCentimeter(0.6);
            var img = p.AddImage(imagePath!);
            img.Width = Unit.FromCentimeter(2.6);
            img.LockAspectRatio = true;
        }

        // Push the body down off the band.
        var spacer = section.AddParagraph();
        spacer.Format.SpaceAfter = Unit.FromCentimeter(0.5);
    }

    private static void RenderPlainHeaderPdf(Section section, ResumeContactDto contact)
    {
        var name = section.AddParagraph(Safe(contact.FullName, "Your Name"));
        name.Format.Font.Size = 18;
        name.Format.Font.Bold = true;
        name.Format.SpaceAfter = 1;

        if (!string.IsNullOrWhiteSpace(contact.Headline))
        {
            var head = section.AddParagraph(contact.Headline.Trim());
            head.Format.Font.Size = 11;
            head.Format.Font.Color = MutedColor;
            head.Format.SpaceAfter = 2;
        }

        var contactLine = ContactLine(contact);
        if (!string.IsNullOrWhiteSpace(contactLine))
        {
            var c = section.AddParagraph(contactLine);
            c.Format.Font.Size = 9.5;
            c.Format.Font.Color = MutedColor;
        }
        AddSpacer(section, 6);
    }

    private static void RenderBodyPdf(Section section, ResumeDataDto data, bool designed)
    {
        // SUMMARY
        if (!string.IsNullOrWhiteSpace(data.Summary))
        {
            HeadingPdf(section, "Summary", designed);
            var p = section.AddParagraph(data.Summary.Trim());
            p.Format.Font.Size = 10;
            p.Format.SpaceAfter = 8;
            p.Format.Alignment = ParagraphAlignment.Justify;
        }

        // EXPERIENCE
        var experience = (data.Experience ?? Array.Empty<ResumeExperienceDto>())
            .Where(e => e is not null && !IsBlankExperience(e)).ToList();
        if (experience.Count > 0)
        {
            HeadingPdf(section, "Experience", designed);
            foreach (var e in experience)
            {
                var head = section.AddParagraph();
                head.Format.SpaceAfter = 0;
                var title = head.AddFormattedText(JoinDash(e.Title, e.Company), TextFormat.Bold);
                title.Size = 10.5;
                var dates = DateRange(e.StartDate, e.EndDate, e.Current);
                var meta = JoinPipe(e.Location, dates);
                if (!string.IsNullOrWhiteSpace(meta))
                {
                    var m = section.AddParagraph(meta);
                    m.Format.Font.Size = 9;
                    m.Format.Font.Color = MutedColor;
                    m.Format.SpaceAfter = 2;
                }
                BulletsPdf(section, e.Bullets);
                AddSpacer(section, 4);
            }
        }

        // EDUCATION
        var education = (data.Education ?? Array.Empty<ResumeEducationDto>())
            .Where(e => e is not null && !IsBlankEducation(e)).ToList();
        if (education.Count > 0)
        {
            HeadingPdf(section, "Education", designed);
            foreach (var e in education)
            {
                var degree = JoinComma(JoinDash(e.Degree, e.Field), e.School);
                var head = section.AddParagraph();
                head.Format.SpaceAfter = 0;
                var ft = head.AddFormattedText(Safe(degree, e.School), TextFormat.Bold);
                ft.Size = 10.5;

                var dates = DateRange(e.StartDate, e.EndDate, current: false);
                var meta = JoinPipe(e.Location, dates,
                    string.IsNullOrWhiteSpace(e.Gpa) ? "" : $"GPA {e.Gpa.Trim()}");
                if (!string.IsNullOrWhiteSpace(meta))
                {
                    var m = section.AddParagraph(meta);
                    m.Format.Font.Size = 9;
                    m.Format.Font.Color = MutedColor;
                    m.Format.SpaceAfter = 1;
                }
                if (!string.IsNullOrWhiteSpace(e.Details))
                {
                    var d = section.AddParagraph(e.Details.Trim());
                    d.Format.Font.Size = 9.5;
                }
                AddSpacer(section, 4);
            }
        }

        // SKILLS
        var skills = (data.Skills ?? Array.Empty<string>())
            .Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).ToList();
        if (skills.Count > 0)
        {
            HeadingPdf(section, "Skills", designed);
            var p = section.AddParagraph(string.Join("  •  ", skills));
            p.Format.Font.Size = 10;
            p.Format.SpaceAfter = 8;
        }

        // PROJECTS
        var projects = (data.Projects ?? Array.Empty<ResumeProjectDto>())
            .Where(p => p is not null && !IsBlankProject(p)).ToList();
        if (projects.Count > 0)
        {
            HeadingPdf(section, "Projects", designed);
            foreach (var pr in projects)
            {
                var head = section.AddParagraph();
                head.Format.SpaceAfter = 0;
                var ft = head.AddFormattedText(Safe(pr.Name, "Project"), TextFormat.Bold);
                ft.Size = 10.5;
                if (!string.IsNullOrWhiteSpace(pr.Link))
                {
                    head.AddText("   ");
                    var link = head.AddFormattedText(pr.Link.Trim());
                    link.Size = 9;
                    link.Color = MutedColor;
                }
                if (!string.IsNullOrWhiteSpace(pr.Description))
                {
                    var d = section.AddParagraph(pr.Description.Trim());
                    d.Format.Font.Size = 9.5;
                    d.Format.SpaceAfter = 1;
                }
                BulletsPdf(section, pr.Bullets);
                AddSpacer(section, 4);
            }
        }

        // CERTIFICATIONS
        var certs = (data.Certifications ?? Array.Empty<ResumeCertificationDto>())
            .Where(c => c is not null && !IsBlankCert(c)).ToList();
        if (certs.Count > 0)
        {
            HeadingPdf(section, "Certifications", designed);
            foreach (var c in certs)
            {
                var line = JoinPipe(JoinDash(c.Name, c.Issuer), c.Date);
                var p = section.AddParagraph();
                var ft = p.AddFormattedText(Safe(c.Name, "Certification"),
                    string.IsNullOrWhiteSpace(c.Name) ? TextFormat.NotBold : TextFormat.Bold);
                ft.Size = 10;
                var rest = JoinPipe(c.Issuer, c.Date);
                if (!string.IsNullOrWhiteSpace(rest))
                {
                    var r = p.AddFormattedText("  —  " + rest);
                    r.Size = 9.5;
                    r.Color = MutedColor;
                }
                p.Format.SpaceAfter = 2;
            }
        }
    }

    private static void HeadingPdf(Section section, string text, bool designed)
    {
        var p = section.AddParagraph(text.ToUpperInvariant());
        p.Format.Font.Bold = true;
        p.Format.Font.Size = 11;
        p.Format.Font.Color = designed ? AccentColor : Colors.Black;
        p.Format.SpaceBefore = 6;
        p.Format.SpaceAfter = 3;
        // A thin accent rule under the heading for the designed style.
        p.Format.Borders.Bottom = new Border
        {
            Width = designed ? 1.0 : 0.6,
            Color = designed ? AccentColor : RuleColor,
        };
    }

    private static void BulletsPdf(Section section, IReadOnlyList<string>? bullets)
    {
        foreach (var b in (bullets ?? Array.Empty<string>()).Where(s => !string.IsNullOrWhiteSpace(s)))
        {
            var p = section.AddParagraph();
            p.Format.LeftIndent = Unit.FromCentimeter(0.5);
            p.Format.FirstLineIndent = Unit.FromCentimeter(-0.35);
            p.Format.Font.Size = 10;
            p.Format.SpaceAfter = 1.5;
            p.AddText("•  " + b.Trim());
        }
    }

    private static void AddText(Section section, string text, bool bold = false, double size = 10, Color? color = null)
    {
        var p = section.AddParagraph(text);
        p.Format.Font.Bold = bold;
        p.Format.Font.Size = size;
        if (color is { } c) p.Format.Font.Color = c;
        p.Format.SpaceAfter = 1;
    }

    private static void AddSpacer(Section section, double points)
    {
        var p = section.AddParagraph();
        p.Format.SpaceAfter = points;
    }

    private static byte[] RenderPdf(Document doc)
    {
        var renderer = new PdfDocumentRenderer { Document = doc };
        renderer.RenderDocument();
        using var ms = new MemoryStream();
        renderer.PdfDocument.Save(ms, closeStream: false);
        return ms.ToArray();
    }

    /// <summary>Write the headshot bytes to a temp file with the right extension (for MigraDoc's file-path-only
    /// <c>AddImage</c>) and return the path; null on missing bytes or an unsupported MIME, so the photo is simply
    /// skipped. The caller deletes the file after the render.</summary>
    private static string? TryWriteTempImage(byte[]? bytes, string? mime)
    {
        if (bytes is null || bytes.Length == 0) return null;
        var ext = ImageExtension(mime);
        if (ext is null) return null;
        try
        {
            var path = Path.Combine(Path.GetTempPath(), "resume_headshot_" + Guid.NewGuid().ToString("N") + ext);
            File.WriteAllBytes(path, bytes);
            return path;
        }
        catch
        {
            return null;
        }
    }

    private static void TryDeleteTemp(string path)
    {
        try { File.Delete(path); } catch { /* best-effort cleanup */ }
    }

    /// <summary>File extension for a supported image MIME (the formats MigraDoc/PDFsharp embed); null = skip.</summary>
    private static string? ImageExtension(string? mime) => mime?.Trim().ToLowerInvariant() switch
    {
        "image/png" => ".png",
        "image/jpeg" or "image/jpg" => ".jpg",
        "image/gif" => ".gif",
        "image/bmp" => ".bmp",
        _ => null,
    };

    // ===========================================================================================
    // DOCX (DocumentFormat.OpenXml)
    // ===========================================================================================

    /// <summary>Render a resume to DOCX. Mirrors the PDF layout in Word terms — a shaded header table for the
    /// designed style (headshot embedded as an <see cref="ImagePart"/>), plain heading paragraphs for ATS.</summary>
    public byte[] BuildResumeDocx(ResumeDataDto data, bool designed, byte[]? headshot, string? headshotMime)
    {
        data ??= ResumeDataDto.Empty;
        using var ms = new MemoryStream();
        using (var doc = WordprocessingDocument.Create(ms, WordprocessingDocumentType.Document))
        {
            var main = doc.AddMainDocumentPart();
            main.Document = new DW.Document();
            var body = main.Document.AppendChild(new Body());

            if (designed)
                RenderDesignedHeaderDocx(main, body, data.Contact, headshot, headshotMime);
            else
                RenderPlainHeaderDocx(body, data.Contact);

            RenderBodyDocx(body, data, designed);
            body.AppendChild(LetterPageSize());
            main.Document.Save();
        }
        return ms.ToArray();
    }

    /// <summary>Render a cover letter to DOCX as a business letter (sender block, date, body paragraphs).</summary>
    public byte[] BuildCoverLetterDocx(string coverLetter, ResumeContactDto contact)
    {
        contact ??= ResumeDataDto.Empty.Contact;
        using var ms = new MemoryStream();
        using (var doc = WordprocessingDocument.Create(ms, WordprocessingDocumentType.Document))
        {
            var main = doc.AddMainDocumentPart();
            main.Document = new DW.Document();
            var body = main.Document.AppendChild(new Body());

            body.AppendChild(Para(Run(contact.FullName, bold: true, size: 26)));
            foreach (var line in SenderLines(contact))
                body.AppendChild(Para(Run(line, size: 19, color: "555B66")));

            body.AppendChild(Spacer());
            body.AppendChild(Para(Run(DateTime.Now.ToString("MMMM d, yyyy", CultureInfo.InvariantCulture), size: 21)));
            body.AppendChild(Spacer());

            foreach (var para in Paragraphs(coverLetter))
                body.AppendChild(JustifiedPara(Run(para, size: 21), spaceAfter: 160));

            body.AppendChild(LetterPageSize());
            main.Document.Save();
        }
        return ms.ToArray();
    }

    // ---- DOCX building blocks -------------------------------------------------------------------

    private static void RenderDesignedHeaderDocx(
        MainDocumentPart main, Body body, ResumeContactDto contact, byte[]? headshot, string? headshotMime)
    {
        var hasPhoto = TryAddImagePart(main, headshot, headshotMime, out var relId);

        var table = new DW.Table();
        table.AppendChild(new TableProperties(
            new TableWidth { Width = "5000", Type = TableWidthUnitValues.Pct },
            new TableLayout { Type = TableLayoutValues.Fixed },
            new TableBorders(
                new TopBorder { Val = BorderValues.None },
                new BottomBorder { Val = BorderValues.None },
                new LeftBorder { Val = BorderValues.None },
                new RightBorder { Val = BorderValues.None },
                new InsideHorizontalBorder { Val = BorderValues.None },
                new InsideVerticalBorder { Val = BorderValues.None })));

        var row = new TableRow();

        // text cell
        var textCell = new TableCell();
        textCell.AppendChild(new TableCellProperties(
            new TableCellWidth { Width = hasPhoto ? "8200" : "10000", Type = TableWidthUnitValues.Dxa },
            new Shading { Val = ShadingPatternValues.Clear, Fill = "1F3A5F" },
            new TableCellVerticalAlignment { Val = TableVerticalAlignmentValues.Center },
            new TableCellMargin(
                new TopMargin { Width = "220", Type = TableWidthUnitValues.Dxa },
                new BottomMargin { Width = "220", Type = TableWidthUnitValues.Dxa },
                new LeftMargin { Width = "300", Type = TableWidthUnitValues.Dxa },
                new RightMargin { Width = "200", Type = TableWidthUnitValues.Dxa })));

        textCell.AppendChild(Para(Run(Safe(contact.FullName, "Your Name"), bold: true, size: 44, color: "FFFFFF")));
        if (!string.IsNullOrWhiteSpace(contact.Headline))
            textCell.AppendChild(Para(Run(contact.Headline.Trim(), size: 23, color: "FFFFFF")));
        var contactLine = ContactLine(contact);
        if (!string.IsNullOrWhiteSpace(contactLine))
            textCell.AppendChild(Para(Run(contactLine, size: 18, color: "FFFFFF")));
        row.AppendChild(textCell);

        // photo cell
        if (hasPhoto)
        {
            var photoCell = new TableCell();
            photoCell.AppendChild(new TableCellProperties(
                new TableCellWidth { Width = "1800", Type = TableWidthUnitValues.Dxa },
                new Shading { Val = ShadingPatternValues.Clear, Fill = "1F3A5F" },
                new TableCellVerticalAlignment { Val = TableVerticalAlignmentValues.Center }));
            var p = new Paragraph(new ParagraphProperties(new Justification { Val = JustificationValues.Center }));
            p.AppendChild(ImageRun(relId, widthEmu: 935_000, heightEmu: 935_000));
            photoCell.AppendChild(p);
            row.AppendChild(photoCell);
        }

        table.AppendChild(row);
        body.AppendChild(table);
        body.AppendChild(Spacer());
    }

    private static void RenderPlainHeaderDocx(Body body, ResumeContactDto contact)
    {
        body.AppendChild(Para(Run(Safe(contact.FullName, "Your Name"), bold: true, size: 36)));
        if (!string.IsNullOrWhiteSpace(contact.Headline))
            body.AppendChild(Para(Run(contact.Headline.Trim(), size: 22, color: "555B66")));
        var contactLine = ContactLine(contact);
        if (!string.IsNullOrWhiteSpace(contactLine))
            body.AppendChild(Para(Run(contactLine, size: 19, color: "555B66")));
        body.AppendChild(Spacer());
    }

    private static void RenderBodyDocx(Body body, ResumeDataDto data, bool designed)
    {
        // SUMMARY
        if (!string.IsNullOrWhiteSpace(data.Summary))
        {
            body.AppendChild(HeadingDocx("Summary", designed));
            body.AppendChild(JustifiedPara(Run(data.Summary.Trim(), size: 20), spaceAfter: 160));
        }

        // EXPERIENCE
        var experience = (data.Experience ?? Array.Empty<ResumeExperienceDto>())
            .Where(e => e is not null && !IsBlankExperience(e)).ToList();
        if (experience.Count > 0)
        {
            body.AppendChild(HeadingDocx("Experience", designed));
            foreach (var e in experience)
            {
                body.AppendChild(Para(Run(JoinDash(e.Title, e.Company), bold: true, size: 21)));
                var meta = JoinPipe(e.Location, DateRange(e.StartDate, e.EndDate, e.Current));
                if (!string.IsNullOrWhiteSpace(meta))
                    body.AppendChild(Para(Run(meta, size: 18, color: "555B66")));
                foreach (var b in CleanBullets(e.Bullets))
                    body.AppendChild(BulletDocx(b));
                body.AppendChild(Spacer(80));
            }
        }

        // EDUCATION
        var education = (data.Education ?? Array.Empty<ResumeEducationDto>())
            .Where(e => e is not null && !IsBlankEducation(e)).ToList();
        if (education.Count > 0)
        {
            body.AppendChild(HeadingDocx("Education", designed));
            foreach (var e in education)
            {
                var degree = JoinComma(JoinDash(e.Degree, e.Field), e.School);
                body.AppendChild(Para(Run(Safe(degree, e.School), bold: true, size: 21)));
                var meta = JoinPipe(e.Location, DateRange(e.StartDate, e.EndDate, current: false),
                    string.IsNullOrWhiteSpace(e.Gpa) ? "" : $"GPA {e.Gpa.Trim()}");
                if (!string.IsNullOrWhiteSpace(meta))
                    body.AppendChild(Para(Run(meta, size: 18, color: "555B66")));
                if (!string.IsNullOrWhiteSpace(e.Details))
                    body.AppendChild(Para(Run(e.Details.Trim(), size: 19)));
                body.AppendChild(Spacer(80));
            }
        }

        // SKILLS
        var skills = (data.Skills ?? Array.Empty<string>())
            .Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).ToList();
        if (skills.Count > 0)
        {
            body.AppendChild(HeadingDocx("Skills", designed));
            body.AppendChild(JustifiedPara(Run(string.Join("  •  ", skills), size: 20), spaceAfter: 160));
        }

        // PROJECTS
        var projects = (data.Projects ?? Array.Empty<ResumeProjectDto>())
            .Where(p => p is not null && !IsBlankProject(p)).ToList();
        if (projects.Count > 0)
        {
            body.AppendChild(HeadingDocx("Projects", designed));
            foreach (var pr in projects)
            {
                var head = new Paragraph();
                head.AppendChild(SpacingProps(spaceAfter: 0));
                head.AppendChild(Run(Safe(pr.Name, "Project"), bold: true, size: 21));
                if (!string.IsNullOrWhiteSpace(pr.Link))
                    head.AppendChild(Run("   " + pr.Link.Trim(), size: 18, color: "555B66"));
                body.AppendChild(head);
                if (!string.IsNullOrWhiteSpace(pr.Description))
                    body.AppendChild(Para(Run(pr.Description.Trim(), size: 19)));
                foreach (var b in CleanBullets(pr.Bullets))
                    body.AppendChild(BulletDocx(b));
                body.AppendChild(Spacer(80));
            }
        }

        // CERTIFICATIONS
        var certs = (data.Certifications ?? Array.Empty<ResumeCertificationDto>())
            .Where(c => c is not null && !IsBlankCert(c)).ToList();
        if (certs.Count > 0)
        {
            body.AppendChild(HeadingDocx("Certifications", designed));
            foreach (var c in certs)
            {
                var p = new Paragraph();
                p.AppendChild(SpacingProps(spaceAfter: 40));
                p.AppendChild(Run(Safe(c.Name, "Certification"), bold: !string.IsNullOrWhiteSpace(c.Name), size: 20));
                var rest = JoinPipe(c.Issuer, c.Date);
                if (!string.IsNullOrWhiteSpace(rest))
                    p.AppendChild(Run("  —  " + rest, size: 19, color: "555B66"));
                body.AppendChild(p);
            }
        }
    }

    private static Paragraph HeadingDocx(string text, bool designed)
    {
        var color = designed ? "1F3A5F" : "000000";
        var ruleColor = designed ? "1F3A5F" : "C9CFD8";
        var props = new ParagraphProperties(
            new SpacingBetweenLines { Before = "120", After = "60" },
            new ParagraphBorders(new BottomBorder
            {
                Val = BorderValues.Single, Color = ruleColor, Size = designed ? 8U : 4U, Space = 1U,
            }));
        var p = new Paragraph(props);
        p.AppendChild(Run(text.ToUpperInvariant(), bold: true, size: 22, color: color));
        return p;
    }

    private static Paragraph BulletDocx(string text)
    {
        var props = new ParagraphProperties(
            new Indentation { Left = "360", Hanging = "200" },
            new SpacingBetweenLines { After = "30" });
        var p = new Paragraph(props);
        p.AppendChild(Run("•  " + text.Trim(), size: 20));
        return p;
    }

    /// <summary>Add the headshot to the package as an <see cref="ImagePart"/> (content type from the MIME) and
    /// hand back its relationship id for an inline drawing. False (skip the photo) on missing/undecodable data
    /// or an unsupported MIME.</summary>
    private static bool TryAddImagePart(MainDocumentPart main, byte[]? bytes, string? mime, out string relId)
    {
        relId = "";
        if (bytes is null || bytes.Length == 0) return false;
        var (partType, ok) = ResolveImagePart(mime);
        if (!ok) return false;
        try
        {
            var part = main.AddImagePart(partType);
            using (var s = new MemoryStream(bytes, writable: false))
                part.FeedData(s);
            relId = main.GetIdOfPart(part);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static (PartTypeInfo type, bool ok) ResolveImagePart(string? mime) =>
        (mime?.Trim().ToLowerInvariant()) switch
        {
            "image/png" => (ImagePartType.Png, true),
            "image/jpeg" or "image/jpg" => (ImagePartType.Jpeg, true),
            "image/gif" => (ImagePartType.Gif, true),
            "image/bmp" => (ImagePartType.Bmp, true),
            "image/tiff" => (ImagePartType.Tiff, true),
            _ => (ImagePartType.Png, false),
        };

    /// <summary>An inline-image run (a <c>w:drawing</c> wrapping a DrawingML picture) sized in EMUs.</summary>
    private static Run ImageRun(string relId, long widthEmu, long heightEmu)
    {
        var docPrId = (uint)Random.Shared.Next(1, int.MaxValue);
        var drawing = new Drawing(
            new WP.Inline(
                new WP.Extent { Cx = widthEmu, Cy = heightEmu },
                new WP.EffectExtent { LeftEdge = 0, TopEdge = 0, RightEdge = 0, BottomEdge = 0 },
                new WP.DocProperties { Id = docPrId, Name = "Headshot" },
                new WP.NonVisualGraphicFrameDrawingProperties(new DRAW.GraphicFrameLocks { NoChangeAspect = true }),
                new DRAW.Graphic(
                    new DRAW.GraphicData(
                        new PIC.Picture(
                            new PIC.NonVisualPictureProperties(
                                new PIC.NonVisualDrawingProperties { Id = 0U, Name = "Headshot" },
                                new PIC.NonVisualPictureDrawingProperties()),
                            new PIC.BlipFill(
                                new DRAW.Blip { Embed = relId },
                                new DRAW.Stretch(new DRAW.FillRectangle())),
                            new PIC.ShapeProperties(
                                new DRAW.Transform2D(
                                    new DRAW.Offset { X = 0L, Y = 0L },
                                    new DRAW.Extents { Cx = widthEmu, Cy = heightEmu }),
                                new DRAW.PresetGeometry(new DRAW.AdjustValueList()) { Preset = DRAW.ShapeTypeValues.Rectangle }))
                    ) { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" }))
            {
                DistanceFromTop = 0U, DistanceFromBottom = 0U, DistanceFromLeft = 0U, DistanceFromRight = 0U,
            });
        return new Run(drawing);
    }

    // ---- small OpenXml run/paragraph helpers ----

    private static Run Run(string text, bool bold = false, int size = 20, string? color = null)
    {
        var props = new RunProperties(new RunFonts { Ascii = FontFamily, HighAnsi = FontFamily });
        if (bold) props.AppendChild(new Bold());
        props.AppendChild(new FontSize { Val = size.ToString(CultureInfo.InvariantCulture) });
        if (color is not null) props.AppendChild(new DW.Color { Val = color });
        var run = new Run();
        run.AppendChild(props);
        run.AppendChild(new Text(text ?? "") { Space = SpaceProcessingModeValues.Preserve });
        return run;
    }

    private static Paragraph Para(params OpenXmlElement[] runs)
    {
        var p = new Paragraph();
        p.AppendChild(SpacingProps(spaceAfter: 20));
        foreach (var r in runs) p.AppendChild(r);
        return p;
    }

    private static Paragraph JustifiedPara(OpenXmlElement run, int spaceAfter)
    {
        var p = new Paragraph(new ParagraphProperties(
            new Justification { Val = JustificationValues.Both },
            new SpacingBetweenLines { After = spaceAfter.ToString(CultureInfo.InvariantCulture) }));
        p.AppendChild(run);
        return p;
    }

    private static ParagraphProperties SpacingProps(int spaceAfter) =>
        new(new SpacingBetweenLines { After = spaceAfter.ToString(CultureInfo.InvariantCulture) });

    private static Paragraph Spacer(int height = 120) =>
        new(new ParagraphProperties(new SpacingBetweenLines { After = height.ToString(CultureInfo.InvariantCulture) }));

    /// <summary>US-Letter section properties (12240 × 15840 twips) with ~0.7in margins.</summary>
    private static SectionProperties LetterPageSize() => new(
        new PageSize { Width = 12240U, Height = 15840U },
        new PageMargin { Top = 1000, Bottom = 1000, Left = 1000, Right = 1000, Header = 720U, Footer = 720U, Gutter = 0U });

    // ===========================================================================================
    // Shared text helpers (used by both renderers)
    // ===========================================================================================

    /// <summary>The one-line contact string: email · phone · location · each link URL, "·"-joined, blanks
    /// dropped.</summary>
    private static string ContactLine(ResumeContactDto c)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(c.Email)) parts.Add(c.Email.Trim());
        if (!string.IsNullOrWhiteSpace(c.Phone)) parts.Add(c.Phone.Trim());
        if (!string.IsNullOrWhiteSpace(c.Location)) parts.Add(c.Location.Trim());
        foreach (var l in c.Links ?? Array.Empty<ResumeLinkDto>())
        {
            if (l is null) continue;
            if (!string.IsNullOrWhiteSpace(l.Url)) parts.Add(l.Url.Trim());
            else if (!string.IsNullOrWhiteSpace(l.Label)) parts.Add(l.Label.Trim());
        }
        return string.Join("  ·  ", parts);
    }

    /// <summary>The sender block lines for a cover letter (each contact field on its own line, blanks dropped).</summary>
    private static IEnumerable<string> SenderLines(ResumeContactDto c)
    {
        if (!string.IsNullOrWhiteSpace(c.Email)) yield return c.Email.Trim();
        if (!string.IsNullOrWhiteSpace(c.Phone)) yield return c.Phone.Trim();
        if (!string.IsNullOrWhiteSpace(c.Location)) yield return c.Location.Trim();
    }

    /// <summary>Split a letter body into paragraphs on blank lines; falls back to a single line if it has no
    /// blank-line breaks. Never returns an empty sequence so the doc is never visually empty.</summary>
    private static IEnumerable<string> Paragraphs(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new[] { "" };
        var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');
        var paras = normalized.Split("\n\n", StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Replace('\n', ' ').Trim())
            .Where(p => p.Length > 0)
            .ToList();
        return paras.Count > 0 ? paras : new List<string> { normalized.Replace('\n', ' ').Trim() };
    }

    private static IEnumerable<string> CleanBullets(IReadOnlyList<string>? bullets) =>
        (bullets ?? Array.Empty<string>()).Where(b => !string.IsNullOrWhiteSpace(b));

    private static string DateRange(string? start, string? end, bool current)
    {
        var s = (start ?? "").Trim();
        var e = current ? "Present" : (end ?? "").Trim();
        if (s.Length == 0 && e.Length == 0) return "";
        if (s.Length == 0) return e;
        if (e.Length == 0) return s;
        return $"{s} – {e}";
    }

    private static string JoinDash(string? a, string? b) => Join(" — ", a, b);
    private static string JoinPipe(params string?[] parts) => Join("  |  ", parts);
    private static string JoinComma(string? a, string? b) => Join(", ", a, b);

    private static string Join(string sep, params string?[] parts) =>
        string.Join(sep, parts.Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => p!.Trim()));

    private static string Safe(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

    // ---- "is this row entirely empty?" guards (skip empty sections) ----

    private static bool IsBlankExperience(ResumeExperienceDto e) =>
        string.IsNullOrWhiteSpace(e.Company) && string.IsNullOrWhiteSpace(e.Title)
        && string.IsNullOrWhiteSpace(e.Location) && string.IsNullOrWhiteSpace(e.StartDate)
        && string.IsNullOrWhiteSpace(e.EndDate) && (e.Bullets is null || e.Bullets.All(string.IsNullOrWhiteSpace));

    private static bool IsBlankEducation(ResumeEducationDto e) =>
        string.IsNullOrWhiteSpace(e.School) && string.IsNullOrWhiteSpace(e.Degree)
        && string.IsNullOrWhiteSpace(e.Field) && string.IsNullOrWhiteSpace(e.Location)
        && string.IsNullOrWhiteSpace(e.Gpa) && string.IsNullOrWhiteSpace(e.Details);

    private static bool IsBlankProject(ResumeProjectDto p) =>
        string.IsNullOrWhiteSpace(p.Name) && string.IsNullOrWhiteSpace(p.Description)
        && string.IsNullOrWhiteSpace(p.Link) && (p.Bullets is null || p.Bullets.All(string.IsNullOrWhiteSpace));

    private static bool IsBlankCert(ResumeCertificationDto c) =>
        string.IsNullOrWhiteSpace(c.Name) && string.IsNullOrWhiteSpace(c.Issuer)
        && string.IsNullOrWhiteSpace(c.Date);
}

/// <summary>
/// The PDFsharp font resolver that lets PDF generation run on the Linux container. PDFsharp 6.x core has no
/// access to GDI/System.Drawing and therefore cannot enumerate system fonts; without a resolver it throws the
/// first time MigraDoc asks for a glyph. This serves the bundled Lato Regular/Bold TTFs (copied next to the dll
/// by the csproj, located via <see cref="AppContext.BaseDirectory"/>) for the single family <c>"Lato"</c>.
///
/// <para>Registration is GUARDED so the global <see cref="GlobalFontSettings.FontResolver"/> is assigned exactly
/// once for the process even under concurrent first-use (<see cref="EnsureRegistered"/> is idempotent and
/// lock-protected). The font bytes are read once and cached.</para>
/// </summary>
internal sealed class LatoFontResolver : IFontResolver
{
    private const string Family = "Lato";
    private const string RegularFace = "Lato#Regular";
    private const string BoldFace = "Lato#Bold";

    private static readonly object Gate = new();
    private static volatile bool _registered;

    private static byte[]? _regular;
    private static byte[]? _bold;

    /// <summary>Assign this resolver to <see cref="GlobalFontSettings.FontResolver"/> once per process.</summary>
    public static void EnsureRegistered()
    {
        if (_registered) return;
        lock (Gate)
        {
            if (_registered) return;
            // Don't clobber a resolver another component may have already set.
            if (GlobalFontSettings.FontResolver is null)
                GlobalFontSettings.FontResolver = new LatoFontResolver();
            _registered = true;
        }
    }

    /// <summary>Map every face request for the "Lato" family (and any unknown family — Lato is the default) to
    /// the regular or bold face.</summary>
    public FontResolverInfo? ResolveTypeface(string familyName, bool isBold, bool isItalic) =>
        new FontResolverInfo(isBold ? BoldFace : RegularFace);

    /// <summary>Return the raw TTF bytes for a face name, reading + caching them from
    /// <c>Assets/fonts/*.ttf</c> next to the dll.</summary>
    public byte[]? GetFont(string faceName) => faceName == BoldFace
        ? (_bold ??= Load("Lato-Bold.ttf"))
        : (_regular ??= Load("Lato-Regular.ttf"));

    private static byte[] Load(string file)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "fonts", file);
        return File.ReadAllBytes(path);
    }
}
