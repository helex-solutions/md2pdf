-- md2pdf-service-mermaid.lua
-- Turn fenced ```mermaid blocks into the markup the md2pdf SERVICE draws:
--   <div class="mermaid-diagram" data-src="<encodeURIComponent(source)>"></div>
-- It is written here as data-md2pdf-src and renamed by md2pdf-service.sh AFTER
-- pandoc: --embed-resources treats data-src as a URL and tries to fetch it.
-- The service renders them with its bundled Mermaid (securityLevel 'strict'),
-- so nothing is rendered locally — no mmdc, no Chrome. Used by md2pdf-service.sh.

local function encode_uri_component(s)
  -- Same set as JavaScript's encodeURIComponent leaves alone; the service
  -- decodes with decodeURIComponent, so anything else is %XX (bytewise UTF-8).
  return (s:gsub("[^%w%-_%.!~%*'%(%)]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

function CodeBlock(el)
  if not el.classes:includes("mermaid") then
    return nil
  end
  return pandoc.RawBlock("html",
    '<div class="mermaid-diagram" data-md2pdf-src="' .. encode_uri_component(el.text) .. '"></div>')
end
