import { useState, useCallback } from 'react';
import { commands } from '../bindings';
import type { FsEntry, FileContent } from '../bindings';

export interface TreeNode {
  entry: FsEntry;
  children: TreeNode[] | null; // null = not loaded yet, undefined = not a dir
  expanded: boolean;
}

export function useFileExplorer(projectDir: string) {
  const [rootEntries, setRootEntries] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (relativePath: string): Promise<TreeNode[]> => {
    const result = await commands.listDirectory(projectDir, relativePath);
    if (result.status === 'ok') {
      return result.data.map((entry: FsEntry) => ({
        entry,
        children: entry.is_dir ? null : undefined,
        expanded: false,
      })) as TreeNode[];
    }
    throw new Error(result.error as string);
  }, [projectDir]);

  const loadRoot = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError(null);
    try {
      const nodes = await loadDir('');
      setRootEntries(nodes);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectDir, loadDir]);

  const toggleDir = useCallback(async (path: string) => {
    const updateNodes = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
      const result: TreeNode[] = [];
      for (const node of nodes) {
        if (node.entry.path === path) {
          if (node.expanded) {
            result.push({ ...node, expanded: false });
          } else {
            let children = node.children;
            if (children === null) {
              try {
                children = await loadDir(path);
              } catch (e) {
                console.error('Failed to load directory:', path, e);
                children = [];
              }
            }
            result.push({ ...node, children, expanded: true });
          }
        } else if (node.children && node.expanded) {
          result.push({ ...node, children: await updateNodes(node.children) });
        } else {
          result.push(node);
        }
      }
      return result;
    };

    const updated = await updateNodes(rootEntries);
    setRootEntries(updated);
  }, [loadDir, rootEntries]);

  const selectFile = useCallback(async (relativePath: string) => {
    setSelectedFile(relativePath);
    setFileContent(null);
    const result = await commands.readFile(projectDir, relativePath);
    if (result.status === 'ok') {
      setFileContent(result.data);
    } else {
      setError(result.error as string);
    }
  }, [projectDir]);

  return {
    rootEntries, selectedFile, fileContent, loading, error,
    loadRoot, toggleDir, selectFile,
  };
}
