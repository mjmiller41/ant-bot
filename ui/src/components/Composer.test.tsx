import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Attachment } from '@antbot/contract';
import { Composer } from './Composer.js';

function makeAttachment(name: string): Attachment {
  return { id: name, messageId: null, path: name, name, mime: 'text/plain', bytes: 3, createdAt: Date.now() };
}

describe('Composer', () => {
  it('sends the message and clears the textarea on Enter', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} bots={[]} skills={[]} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello there' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello there', []);
    expect(textarea.value).toBe('');
  });

  it('does not send on Shift+Enter', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} bots={[]} skills={[]} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'line one' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send an empty/whitespace-only message', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} bots={[]} skills={[]} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('uploads attachments and caps them at 6, ignoring extras', async () => {
    let counter = 0;
    const uploadFile = vi.fn(async (file: File) => makeAttachment(file.name || `f${counter++}`));
    render(<Composer onSend={vi.fn()} bots={[]} skills={[]} uploadFile={uploadFile} />);
    const input = screen.getByTestId('attachment-input') as HTMLInputElement;

    const files = Array.from({ length: 7 }, (_, i) => new File(['x'], `file-${i}.txt`, { type: 'text/plain' }));
    fireEvent.change(input, { target: { files } });

    await waitFor(() => {
      expect(screen.getAllByTestId('attachment-chip')).toHaveLength(6);
    });
    expect(uploadFile).toHaveBeenCalledTimes(6);
  });

  it('removes an attachment chip when its remove button is clicked', async () => {
    const uploadFile = vi.fn(async (file: File) => makeAttachment(file.name));
    render(<Composer onSend={vi.fn()} bots={[]} skills={[]} uploadFile={uploadFile} />);
    const input = screen.getByTestId('attachment-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } });

    await waitFor(() => expect(screen.getAllByTestId('attachment-chip')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /remove a.txt/i }));
    expect(screen.queryAllByTestId('attachment-chip')).toHaveLength(0);
  });

  it('shows a Stop button while running and fires onStop', () => {
    const onStop = vi.fn();
    render(<Composer onSend={vi.fn()} bots={[]} skills={[]} running onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
