using System.Security.Cryptography;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using WixToolset.Dtf.WindowsInstaller;
using WixToolset.Dtf.WindowsInstaller.Package;

// This program reads MSI tables/cabinets. It never opens an installation session,
// executes a sequence, invokes msiexec, or runs a package custom action.
if (args.Length == 3 && args[0] == "--bootstrapper")
{
    try
    {
        object ReadXml(string name)
        {
            using var reader = XmlReader.Create(Path.Combine(args[1],name),new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2 * 1024 * 1024 });
            var document = XDocument.Load(reader);
            if (document.Root == null) throw new InvalidDataException();
            return document.Root.DescendantsAndSelf().Select(element => new {name=element.Name.LocalName,parent=element.Parent?.Name.LocalName,attributes=element.Attributes().Where(attribute=>!attribute.IsNamespaceDeclaration).ToDictionary(attribute=>attribute.Name.LocalName,attribute=>attribute.Value)}).ToArray();
        }
        File.WriteAllText(args[2],JsonSerializer.Serialize(new {manifest=ReadXml("manifest.xml"),application=ReadXml("BootstrapperApplicationData.xml"),extension=ReadXml("BootstrapperExtensionData.xml")}));
        return 0;
    }
    catch { Console.Error.WriteLine("INSTALLER_AUDIT_CODE=DTF_BUNDLE_XML_INVALID"); return 1; }
}
if (args.Length != 2) return 2;
var operation = "OPEN";
try
{
    var msi = Path.GetFullPath(args[0]);
    var output = Path.GetFullPath(args[1]);
    if (Directory.Exists(output)) throw new InvalidDataException();
    Directory.CreateDirectory(output);
    using var package = new InstallPackage(msi, DatabaseOpenMode.ReadOnly);
    package.WorkingDirectory = Path.Combine(output, "files");
    Directory.CreateDirectory(package.WorkingDirectory);
    operation = "PROPERTIES";
    var properties = new Dictionary<string,string>();
    using (var view = package.OpenView("SELECT `Property`, `Value` FROM `Property`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record) properties.Add(record.GetString(1),record.GetString(2));
    }
    operation = "DIRECTORIES";
    var directories = new Dictionary<string,(string parent,string name)>();
    using (var view = package.OpenView("SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            directories.Add(record.GetString(1),(record.GetString(2),record.GetString(3).Split(':')[0].Split('|').Last()));
    }
    string RelativeDirectory(string id, HashSet<string>? visited = null)
    {
        if (id == "INSTALLFOLDER") return "";
        visited ??= new HashSet<string>();
        if (!visited.Add(id) || !directories.TryGetValue(id,out var directory) || String.IsNullOrEmpty(directory.parent)) throw new InvalidDataException();
        return Path.Combine(RelativeDirectory(directory.parent,visited),directory.name == "." ? "" : directory.name);
    }
    string Confined(string root,string relative)
    {
        if (Path.IsPathRooted(relative)) throw new InvalidDataException();
        var full = Path.GetFullPath(Path.Combine(root,relative));
        if (!full.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
        return full;
    }
    operation = "COMPONENTS";
    var components = new Dictionary<string,(string directory,int attributes,string keyPath)>();
    using (var view = package.OpenView("SELECT `Component`, `Directory_`, `Attributes`, `KeyPath` FROM `Component`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            components.Add(record.GetString(1),(record.GetString(2),record.GetInteger(3),record.GetString(4)));
    }
    operation = "FILES";
    var files = new List<(string id,string relative,string source)>();
    long declaredBytes = 0;
    using (var view = package.OpenView("SELECT `File`, `Component_`, `FileName`, `Attributes`, `FileSize` FROM `File`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
        {
            var id = record.GetString(1);
            declaredBytes += record.GetInteger(5);
            if ((record.GetInteger(4) & 0x2000) != 0 || declaredBytes > 2L * 1024 * 1024 * 1024 || files.Count >= 100000) throw new InvalidDataException();
            var component = components[record.GetString(2)];
            if ((component.attributes & 4) == 0 || (component.attributes & 16) != 0) throw new InvalidDataException();
            var relative = Path.Combine(RelativeDirectory(component.directory),record.GetString(3).Split('|').Last());
            Confined(package.WorkingDirectory,relative);
            var source = Confined(package.WorkingDirectory,package.Files[id].SourcePath);
            files.Add((id,relative.Replace('\\','/'),source));
        }
    }
    operation = "REGISTRY";
    var registry = new List<object>();
    var registryKeyPaths = new HashSet<string>();
    using (var view = package.OpenView("SELECT `Registry`, `Root`, `Key`, `Name`, `Component_`, `Value` FROM `Registry`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
        {
            if (record.GetInteger(2) != 1) throw new InvalidDataException();
            var component = components[record.GetString(5)];
            if ((component.attributes & 4) == 0 || (component.attributes & 16) != 0) throw new InvalidDataException();
            if (component.keyPath == record.GetString(1)) registryKeyPaths.Add(record.GetString(5));
            registry.Add(new {id=record.GetString(1),root=record.GetInteger(2),key=record.GetString(3),name=record.GetString(4),component=record.GetString(5),value=record.GetString(6)});
        }
    }
    if (registryKeyPaths.Count != components.Count) throw new InvalidDataException();
    operation = "SHORTCUTS";
    var shortcuts = new List<object>();
    using (var view = package.OpenView("SELECT `Shortcut`, `Directory_`, `Target`, `Arguments`, `WkDir` FROM `Shortcut`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            shortcuts.Add(new {id=record.GetString(1),directory=record.GetString(2),target=record.GetString(3),arguments=record.GetString(4),workingDirectory=record.GetString(5)});
    }
    operation = "REMOVALS";
    var removals = new List<object>();
    using (var view = package.OpenView("SELECT `FileKey`, `FileName`, `DirProperty`, `InstallMode` FROM `RemoveFile`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            removals.Add(new {id=record.GetString(1),filename=record.GetString(2),directory=record.GetString(3),mode=record.GetInteger(4)});
    }
    operation = "CUSTOM_ACTIONS";
    var customActions = new List<object>();
    if (package.Tables.Contains("CustomAction"))
    using (var view = package.OpenView("SELECT `Action`, `Type`, `Source`, `Target` FROM `CustomAction`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            customActions.Add(new {id=record.GetString(1),type=record.GetInteger(2),source=record.GetString(3),target=record.GetString(4)});
    }
    operation = "UPGRADE";
    var upgrade = new List<object>();
    using (var view = package.OpenView("SELECT `UpgradeCode`, `VersionMin`, `VersionMax`, `Attributes`, `ActionProperty` FROM `Upgrade`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            upgrade.Add(new {code=record.GetString(1),minimum=record.GetString(2),maximum=record.GetString(3),attributes=record.GetInteger(4),property=record.GetString(5)});
    }
    operation = "SEQUENCE";
    var actions = new Dictionary<string,int>();
    using (var view = package.OpenView("SELECT `Action`, `Sequence` FROM `InstallExecuteSequence`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record) actions.Add(record.GetString(1),record.GetInteger(2));
    }
    operation = "SEARCH";
    var searches = new List<object>();
    using (var view = package.OpenView("SELECT `Signature_`, `Root`, `Key`, `Name`, `Type` FROM `RegLocator`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            searches.Add(new {id=record.GetString(1),root=record.GetInteger(2),key=record.GetString(3),name=record.GetString(4),type=record.GetInteger(5)});
    }
    var appSearch = new List<object>();
    using (var view = package.OpenView("SELECT `Property`, `Signature_` FROM `AppSearch`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record) appSearch.Add(new {property=record.GetString(1),signature=record.GetString(2)});
    }
    operation = "LAUNCH";
    var launchConditions = new List<object>();
    using (var view = package.OpenView("SELECT `Condition`, `Description` FROM `LaunchCondition`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record) launchConditions.Add(new {condition=record.GetString(1),description=record.GetString(2)});
    }
    operation = "MEDIA";
    // Every included cabinet must be embedded; no arbitrary filesystem source reads.
    using (var view = package.OpenView("SELECT `Cabinet` FROM `Media`"))
    {
        view.Execute();
        while (view.Fetch() is Record record) using (record)
            if (!record.GetString(1).StartsWith('#')) throw new InvalidDataException();
    }
    operation = "EXTRACT";
    package.ExtractFiles();
    var manifest = files.Select(file => new {path=file.relative,size=new FileInfo(file.source).Length,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file.source))).ToLowerInvariant(),source=file.source});
    operation = "MANIFEST";
    var binaryCount = package.Tables.Contains("Binary") ? package.CountRows("Binary") : 0;
    var installationDirectory = directories["INSTALLFOLDER"];
    var programsDirectory = directories["ProgramsDirectory"];
    var evidence = new {properties,template=package.SummaryInfo.Template,files=manifest,registry,customActions,upgrade,actions,binaryCount,shortcuts,removals,searches,appSearch,launchConditions,
        installDirectoryName=installationDirectory.name,installDirectoryParent=installationDirectory.parent,programsDirectoryName=programsDirectory.name,programsDirectoryParent=programsDirectory.parent};
    File.WriteAllText(Path.Combine(output,"inspection.json"),JsonSerializer.Serialize(evidence));
    return 0;
}
catch (Exception error)
{
    var code = error is InstallerException ? "MSI" : error is InvalidDataException ? "INVALID" : error is IOException ? "IO" : "UNEXPECTED";
    Console.Error.WriteLine("INSTALLER_AUDIT_CODE=DTF_" + operation + "_" + code);
    return 1;
}
